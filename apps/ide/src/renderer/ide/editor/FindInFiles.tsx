/**
 * Search > Find in Files: dialog, search over project files / a folder / the open documents, and the "Search
 * Results" pane (double-click opens the match). Runs in the renderer over the existing files.readDir/readText
 * contract (no main-side search service); open documents are searched with their unsaved text.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog } from '../../common/controls';
import { ListView } from '../../common/views';
import { findInText, maskMatcher, type TextMatch, type TextSearchOptions } from '../../common/monaco/asmText';
import type { S12Api } from '../../../shared/api';
import { baseName, isBinaryPath, samePath } from './documents';

export type SearchScope = 'project' | 'folder' | 'open';

export interface FindInFilesRequest extends TextSearchOptions {
  query: string;
  scope: SearchScope;
  /** Folder scope. */
  folder?: string;
  recursive?: boolean;
  /** File mask ("*.asm;*.inc"); empty = all text files. */
  mask?: string;
}

export interface FileMatches {
  path: string;
  name: string;
  matches: TextMatch[];
}

export interface SearchSummary {
  request: FindInFilesRequest;
  files: FileMatches[];
  searched: number;
  total: number;
  error?: string;
}

const MAX_FILES = 2000;
const MAX_DEPTH = 12;

async function listFolder(api: S12Api, dir: string, recursive: boolean, accept: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (out.length >= MAX_FILES) return;
    const entries = await api.files.readDir(d).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory) {
        if (recursive && depth < MAX_DEPTH && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(e.path, depth + 1);
      } else if (accept(e.name) && !isBinaryPath(e.name)) out.push(e.path);
    }
  };
  await walk(dir, 0);
  return out;
}

/**
 * Run a search. `openText(path)` returns an open document's current text (unsaved edits win over the disk copy).
 */
export async function searchFiles(api: S12Api, req: FindInFilesRequest, ctx: { projectFiles: string[]; openDocs: { path: string; text: string }[] }): Promise<SearchSummary> {
  const accept = maskMatcher(req.mask ?? '');
  let paths: string[];
  if (req.scope === 'open') paths = ctx.openDocs.map((d) => d.path);
  else if (req.scope === 'project') paths = ctx.projectFiles.filter((p) => !isBinaryPath(p) && accept(baseName(p)));
  else paths = req.folder ? await listFolder(api, req.folder, req.recursive ?? true, accept) : [];
  const summary: SearchSummary = { request: req, files: [], searched: 0, total: 0 };
  try {
    findInText('', req.query, req); // validate the regex once
    findInText('x', req.query, req);
  } catch (e) {
    return { ...summary, error: `Invalid regular expression: ${(e as Error).message}` };
  }
  const seen = new Set<string>();
  for (const p of paths) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const open = ctx.openDocs.find((d) => samePath(d.path, p));
    const text = open ? open.text : await api.files.readText(p).then((f) => f.text, () => null);
    if (text === null) continue;
    summary.searched++;
    const matches = findInText(text, req.query, req);
    if (matches.length) {
      summary.files.push({ path: p, name: baseName(p), matches });
      summary.total += matches.length;
    }
  }
  return summary;
}

// ------------------------------------------------------------------------------------------------ dialog

export interface FindInFilesDialogProps {
  open: boolean;
  initial: Partial<FindInFilesRequest>;
  hasProject: boolean;
  onFind: (req: FindInFilesRequest) => void;
  onCancel: () => void;
  onBrowse: () => Promise<string | null>;
}

export function FindInFilesDialog({ open, initial, hasProject, onFind, onCancel, onBrowse }: FindInFilesDialogProps) {
  const [req, setReq] = useState<FindInFilesRequest>({ query: '', scope: hasProject ? 'project' : 'open', mask: '*.asm;*.inc', recursive: true });
  /** The user picked a scope: keep it across openings (else default to the project when there is one). */
  const chosenScope = useRef(false);
  useEffect(() => {
    if (!open) return;
    setReq((r) => {
      let scope = initial.scope ?? (chosenScope.current ? r.scope : hasProject ? 'project' : 'open');
      if (scope === 'project' && !hasProject) scope = 'open';
      return { ...r, ...initial, scope };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (p: Partial<FindInFilesRequest>) => {
    if (p.scope) chosenScope.current = true;
    setReq((r) => ({ ...r, ...p }));
  };
  const canFind = req.query !== '' && (req.scope !== 'folder' || !!req.folder);
  const find = () => canFind && onFind(req);
  return (
    <Dialog
      title="Find in Files"
      open={open}
      onClose={onCancel}
      width={460}
      testId="find-in-files-dialog"
      buttons={
        <>
          <Button isDefault disabled={!canFind} onClick={find} testId="find-in-files-find">
            Find All
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 8px', alignItems: 'center' }}>
        <label htmlFor="fif-query">Find:</label>
        <input
          id="fif-query"
          className="cw-field"
          autoFocus
          value={req.query}
          onChange={(e) => set({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              find();
            }
          }}
          data-testid="find-in-files-query"
        />
        <span />
        <div style={{ display: 'flex', gap: 12 }}>
          <Checkbox label="Match case" checked={!!req.matchCase} onChange={(v) => set({ matchCase: v })} />
          <Checkbox label="Entire word" checked={!!req.wholeWord} onChange={(v) => set({ wholeWord: v })} />
          <Checkbox label="Regular expression" checked={!!req.regex} onChange={(v) => set({ regex: v })} />
        </div>
        <span>Search in:</span>
        <div style={{ display: 'flex', gap: 12 }} role="radiogroup">
          {(
            [
              ['project', 'Project files', !hasProject],
              ['folder', 'Folder', false],
              ['open', 'Open documents', false],
            ] as const
          ).map(([v, label, disabled]) => (
            <label key={v} className={`cw-check${disabled ? ' disabled' : ''}`}>
              <input type="radio" name="fif-scope" checked={req.scope === v} disabled={disabled} onChange={() => set({ scope: v })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <label htmlFor="fif-folder">Folder:</label>
        <div style={{ display: 'flex', gap: 4 }}>
          <input id="fif-folder" className="cw-field" style={{ flex: 1 }} disabled={req.scope !== 'folder'} value={req.folder ?? ''} onChange={(e) => set({ folder: e.target.value })} />
          <Button
            disabled={req.scope !== 'folder'}
            onClick={() =>
              void onBrowse().then((p) => {
                if (p) set({ folder: p });
              })
            }
          >
            Browse...
          </Button>
        </div>
        <label htmlFor="fif-mask">File mask:</label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input id="fif-mask" className="cw-field" style={{ flex: 1 }} disabled={req.scope === 'open'} value={req.mask ?? ''} onChange={(e) => set({ mask: e.target.value })} />
          <Checkbox label="Subfolders" checked={req.recursive ?? true} disabled={req.scope !== 'folder'} onChange={(v) => set({ recursive: v })} />
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ results pane

interface ResultRow {
  key: string;
  path: string;
  name: string;
  m: TextMatch;
}

export function SearchResultsPane({ summary, busy, onOpen, onClose }: { summary: SearchSummary | null; busy: boolean; onOpen: (path: string, line: number, column: number) => void; onClose: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const rows: ResultRow[] = (summary?.files ?? []).flatMap((f) => f.matches.map((m, i) => ({ key: `${f.path}#${i}`, path: f.path, name: f.name, m })));
  const head = busy
    ? 'Searching...'
    : summary?.error
      ? summary.error
      : summary
        ? `${summary.total} match${summary.total === 1 ? '' : 'es'} for "${summary.request.query}" in ${summary.files.length} of ${summary.searched} file${summary.searched === 1 ? '' : 's'}`
        : '';
  return (
    <div className="s12-search-results" data-testid="search-results">
      <div className="cw-caption active">
        <span style={{ flex: 1 }}>Search Results</span>
        <button type="button" className="cw-tool-btn" style={{ height: 14, minWidth: 16 }} onClick={onClose} aria-label="Close search results">
          {'×'}
        </button>
      </div>
      <div className="s12-search-head">{head}</div>
      <ListView
        columns={[
          { id: 'file', header: 'File', width: 140, render: (r: ResultRow) => r.name },
          { id: 'line', header: 'Line', width: 50, align: 'right', render: (r: ResultRow) => r.m.line },
          { id: 'text', header: 'Text', render: (r: ResultRow) => <MatchText m={r.m} /> },
        ]}
        rows={rows}
        rowKey={(r) => r.key}
        selected={sel}
        onSelect={(k) => setSel(k)}
        onActivate={(_k, r) => onOpen(r.path, r.m.line, r.m.column)}
        testId="search-results-list"
      />
    </div>
  );
}

function MatchText({ m }: { m: TextMatch }) {
  const t = m.text.replace(/\t/g, ' ');
  const a = m.column - 1;
  return (
    <span className="cw-mono" style={{ whiteSpace: 'pre' }}>
      {t.slice(0, a)}
      <b>{t.slice(a, a + m.length)}</b>
      {t.slice(a + m.length)}
    </span>
  );
}
