/**
 * Project > Debug: work out which connection .ini and application to start the debugger with.
 */
import { access, readFile } from 'node:fs/promises';
import { parseIni } from '@s12/formats';
import { ApiError } from '../../shared/api/common';
import type { LaunchRequest } from '../../shared/api/debug';
import type { OpenSessionRequest } from '../../worker/protocol';
import type { ProjectService } from './project-service';

/** The connection S12 Studio debugs on when the project's own connection cannot be used. */
const FCS_NAME = 'Full_Chip_Simulation';

export async function resolveLaunch(projects: ProjectService, req: LaunchRequest, defaults: Partial<OpenSessionRequest> = {}): Promise<OpenSessionRequest> {
  const p = projects.current;
  if (!p) {
    if (!req.iniPath && !req.absPath) throw new ApiError('no-project', 'open a project (or pass iniPath/absPath) before starting the debugger');
    const base = req.iniPath ?? req.absPath!;
    return { ...defaults, iniPath: req.iniPath, absPath: req.absPath, projectDir: base.replace(/[\\/][^\\/]*$/, '') || '.', load: req.load };
  }
  const cfg = await p.debuggerConfig(req.target);
  let iniPath = req.iniPath ?? cfg.iniPath;
  let conn = cfg.connections.find((c) => samePath(c.iniPath, iniPath));
  // Simulator connections of the project, Full_Chip_Simulation.ini first.
  const sim = cfg.connections
    .filter((c) => (c.target ?? '').toLowerCase() === 'sim')
    .sort((a, b) => Number(b.name.toLowerCase() === FCS_NAME.toLowerCase()) - Number(a.name.toLowerCase() === FCS_NAME.toLowerCase()))[0];
  const notes: string[] = [];
  if (!req.iniPath && iniPath && !conn && !(await exists(iniPath))) {
    // The .mcp names a connection .ini that is not in the project folder (deleted, or only the .mcp was extracted
    // from a zip): debug on the project's Full Chip Simulation connection instead of failing.
    if (!sim) throw new ApiError('not-found', `The project's connection file ${fileName(iniPath)} is missing and there is no ${FCS_NAME}.ini in ${p.dir} to use instead`);
    notes.push(`Note: the project's connection file ${fileName(iniPath)} was not found, so S12 Studio uses ${fileName(sim.iniPath)}.`);
    iniPath = sim.iniPath;
    conn = sim;
  }
  let fallbackFrom: OpenSessionRequest['fallbackFrom'];
  const connTarget = (conn?.target ?? (iniPath ? await iniTarget(iniPath) : 'sim')).toLowerCase();
  if (connTarget !== 'sim') {
    // UNCERTAIN/TEMPORARY: until real hardware targets exist (M8) a non-simulator connection (a course .mcp selects
    // P&E_Multilink_USB.ini, Target=icd12) is debugged with the project's Full Chip Simulation connection; the
    // engine shows hardwareFallbackMessage() once per project and emits `debug.notice`.
    fallbackFrom = { name: conn?.name ?? stem(iniPath ?? ''), target: conn?.target ?? connTarget, iniPath };
    iniPath = sim?.iniPath;
  }
  const absPath = req.absPath ?? p.target(req.target).absPath;
  return { ...defaults, iniPath, projectDir: p.dir, absPath, load: req.load ?? !!absPath, compilerDir: projects.compilerDir, fallbackFrom, ...(notes.length ? { notes } : {}) };
}

const samePath = (a?: string, b?: string): boolean => !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const stem = (p: string): string => fileName(p).replace(/\.ini$/i, '');

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** `[HI-WAVE] Target=` of a connection .ini (default 'sim'). */
async function iniTarget(iniPath: string): Promise<string> {
  try {
    return (parseIni(new TextDecoder('latin1').decode(await readFile(iniPath))).get('HI-WAVE', 'Target') ?? 'sim').trim() || 'sim';
  } catch {
    return 'sim';
  }
}
