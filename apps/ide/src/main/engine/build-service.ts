/**
 * BuildService: Make / Bring Up To Date / Compile / Remove Object Code on the open project via @s12/project.
 * One build at a time; progress and messages stream as `build.*` events; the result updates the project window.
 */
import { bringUpToDate, compileFile, make, removeObjectCode, type BuildOptions, type BuildResult } from '@s12/project';
import { ApiError } from '../../shared/api/common';
import type { BuildKind, BuildMessageInfo, BuildProgressInfo, BuildRequest, BuildResultInfo } from '../../shared/api/build';
import type { EventBus } from '../events';
import type { ProjectService } from './project-service';

export class BuildService {
  private running: { kind: BuildKind; abort: AbortController; done: Promise<unknown> } | null = null;
  private last: BuildResultInfo | null = null;
  /** Called after every finished build (main wires the "rebuilt while debugging" notice). Errors are ignored. */
  onFinished: ((info: BuildResultInfo, kind: BuildKind) => void | Promise<void>) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly projects: ProjectService,
    /** Windows login stand-in recorded in .note sections (CodeWarrior writes the user name). */
    private readonly user = 'user',
  ) {}

  get building(): boolean {
    return this.running !== null;
  }

  lastResult(): BuildResultInfo | null {
    return this.last;
  }

  make(req: BuildRequest = {}): Promise<BuildResultInfo> {
    return this.run('make', req, (p, o) => make(p, o));
  }

  bringUpToDate(req: BuildRequest = {}): Promise<BuildResultInfo> {
    return this.run('bringUpToDate', req, (p, o) => bringUpToDate(p, o));
  }

  /** Compile several files: one compileFile() per file, results merged. */
  compile(names: string[], req: BuildRequest = {}): Promise<BuildResultInfo> {
    if (!names.length) return Promise.reject(new ApiError('invalid-argument', 'no files to compile'));
    return this.run('compile', req, async (p, o) => {
      let merged: BuildResult | null = null;
      for (const n of names) {
        const r = await compileFile(p, n, o);
        merged = merged ? mergeResults(merged, r) : r;
        if (r.cancelled) break;
      }
      if (!merged) throw new ApiError('invalid-argument', 'no files to compile');
      return merged;
    });
  }

  async stop(): Promise<void> {
    const r = this.running;
    if (!r) return;
    r.abort.abort();
    await r.done.catch(() => undefined);
  }

  async removeObjectCode(req: { target?: string; allTargets?: boolean } = {}): Promise<string[]> {
    if (this.running) throw new ApiError('busy', 'a build is running');
    const removed = await removeObjectCode(this.projects.require(), req);
    await this.projects.refreshStatus();
    await this.projects.changed();
    return removed;
  }

  private async run(kind: BuildKind, req: BuildRequest, fn: (p: ReturnType<ProjectService['require']>, o: BuildOptions) => Promise<BuildResult>): Promise<BuildResultInfo> {
    const project = this.projects.require();
    if (this.running) throw new ApiError('busy', 'a build is already running');
    const abort = new AbortController();
    const target = req.target ?? project.currentTarget.name;
    const t0 = Date.now();
    let lastStep: BuildProgressInfo['step'] = 'check';
    let lastFile: string | undefined;
    const streamed: BuildMessageInfo[] = [];
    const opts: BuildOptions = {
      target,
      force: req.force,
      // the project window's Touch marks: those files are reassembled even when up to date
      forceFiles: this.projects.userTouchedFiles(),
      user: this.user,
      signal: abort.signal,
      onMessage: (m) => {
        streamed.push({ ...m });
        this.bus.emit('build', 'message', { ...m }, 'ide');
      },
      onProgress: (p) => {
        lastStep = p.step;
        lastFile = p.file;
        this.bus.emit('build', 'progress', { ...p }, 'ide');
      },
    };
    this.bus.emit('build', 'started', { kind, target }, 'ide');
    const done = fn(project, opts);
    this.running = { kind, abort, done };
    let info: BuildResultInfo;
    try {
      const r = await done;
      info = { ...r, messages: r.messages.map((m) => ({ ...m })), files: r.files.map((f) => ({ ...f, includes: [...f.includes] })), elapsedMs: Date.now() - t0 };
    } catch (e) {
      // An exception out of the build (EACCES/EBUSY writing an output, a vanished directory...) still ends the build:
      // the failure becomes an error message and a failed result, so the IDE leaves its "building" state.
      const m = failureMessage(e, lastStep, lastFile);
      this.bus.emit('build', 'message', m, 'ide');
      const messages = [...streamed, m];
      info = {
        ok: false,
        target,
        errors: messages.filter((x) => x.severity === 'error').length,
        warnings: messages.filter((x) => x.severity === 'warning').length,
        messages,
        upToDate: false,
        compiled: [],
        skipped: [],
        linked: false,
        burned: false,
        outputs: [],
        files: [],
        cancelled: abort.signal.aborted || undefined,
        elapsedMs: Date.now() - t0,
      };
    } finally {
      this.running = null;
    }
    this.last = info;
    this.projects.applyBuildFiles(info.files);
    this.bus.emit('build', 'finished', info, 'ide');
    await this.projects.changed().catch(() => undefined);
    try {
      await this.onFinished?.(info, kind);
    } catch {
      // a notification failure never fails the build
    }
    return info;
  }
}

const TOOL_OF_STEP: Record<BuildProgressInfo['step'], BuildMessageInfo['tool']> = { check: 'project', assemble: 'assembler', link: 'linker', burn: 'burner', done: 'project' };

/**
 * The Errors & Warnings entry for a build that threw.
 * UNCERTAIN: CodeWarrior's wording for an I/O failure during Make (it shows the OS error under the tool's name);
 * we report the step, the file being processed and the OS message.
 */
export function failureMessage(e: unknown, step: BuildProgressInfo['step'], file?: string): BuildMessageInfo {
  const err = e as NodeJS.ErrnoException;
  const path = typeof err?.path === 'string' ? err.path : undefined;
  const what = step === 'link' ? 'Linking' : step === 'burn' ? 'Burning' : step === 'assemble' ? 'Assembling' : 'Building';
  const text = `${what}${file ? ` ${file}` : ''} failed: ${err?.message ?? String(e)}`;
  const where = path ?? undefined;
  const display = `${'Error'.padEnd(8)}: ${text}\n${where ? `${where.split(/[\\/]/).pop()}\n` : ''}`;
  return { severity: 'error', tool: TOOL_OF_STEP[step], text, file: where, display };
}

function mergeResults(a: BuildResult, b: BuildResult): BuildResult {
  return {
    ...b,
    ok: a.ok && b.ok,
    errors: a.errors + b.errors,
    warnings: a.warnings + b.warnings,
    messages: [...a.messages, ...b.messages],
    upToDate: a.upToDate && b.upToDate,
    compiled: [...a.compiled, ...b.compiled],
    skipped: [...a.skipped, ...b.skipped],
    outputs: [...a.outputs, ...b.outputs],
    files: [...a.files, ...b.files],
    cancelled: a.cancelled || b.cancelled,
  };
}
