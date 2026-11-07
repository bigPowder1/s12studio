/**
 * Message protocol between main (src/main/engine/debug-host.ts) and the debug engine worker thread
 * (src/worker/debug-worker.ts). Methods are named `<domain>.<method>`:
 *   - `debug.*` / `board.*`  = the shared DebugApi / BoardApi methods (minus main-only ones such as debug.launch)
 *   - `engine.*`             = host-only lifecycle methods (EngineMethods below)
 */
import type { ApiErrorCode } from '../shared/api/common';
import type { PacingMode, SessionInfo } from '../shared/api/debug';

export interface OpenSessionRequest {
  /** Connection .ini (absent: bare sim session with the project directory as base). */
  iniPath?: string;
  projectDir: string;
  /** Application to load after connecting. */
  absPath?: string;
  /** Load absPath (default true when given). */
  load?: boolean;
  pacing?: PacingMode;
  speedFactor?: number;
  /** Snapshot rate while running (default 30 Hz). */
  snapshotHz?: number;
  /** {Compiler} root for environment paths. */
  compilerDir?: string;
  /** The project's hardware connection that was replaced by `iniPath` (Full Chip Simulation) - see SessionInfo. */
  fallbackFrom?: { name: string; target: string; iniPath?: string };
  /** Informational lines for the command window when the session opens (e.g. a missing connection .ini replaced). */
  notes?: string[];
}

/** Host-only methods (not part of window.s12). */
export interface EngineMethods {
  'engine.openSession'(req: OpenSessionRequest): Promise<SessionInfo>;
  'engine.ping'(): Promise<'pong'>;
}

export type ToWorker = { type: 'call'; id: number; method: string; args: unknown[] } | { type: 'dispose' };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: { code: ApiErrorCode; message: string } }
  | { type: 'event'; domain: 'debug' | 'board'; event: string; payload: unknown };
