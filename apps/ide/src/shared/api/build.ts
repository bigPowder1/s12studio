/** Build API (IDE window): Make / Compile / Bring Up To Date / Remove Object Code through @s12/project. */

export type BuildSeverity = 'error' | 'warning' | 'information';

export interface BuildMessageInfo {
  severity: BuildSeverity;
  tool: 'assembler' | 'linker' | 'burner' | 'project';
  code?: string;
  text: string;
  /** Real path of the file the message is about. */
  file?: string;
  line?: number;
  column?: number;
  callFile?: string;
  callLine?: number;
  /** CodeWarrior "Errors & Warnings" rendering. */
  display: string;
}

export interface BuildProgressInfo {
  step: 'check' | 'assemble' | 'link' | 'burn' | 'done';
  file?: string;
  done: number;
  total: number;
}

export interface FileBuildInfoDTO {
  name: string;
  path?: string;
  object?: string;
  code: number;
  data: number;
  compiled: boolean;
  ok: boolean;
  includes: string[];
}

export interface BuildResultInfo {
  ok: boolean;
  target: string;
  errors: number;
  warnings: number;
  messages: BuildMessageInfo[];
  upToDate: boolean;
  compiled: string[];
  skipped: string[];
  linked: boolean;
  burned: boolean;
  outputs: string[];
  absPath?: string;
  mapPath?: string;
  files: FileBuildInfoDTO[];
  cancelled?: boolean;
  /** Wall time of the build (ms). */
  elapsedMs: number;
}

export type BuildKind = 'make' | 'bringUpToDate' | 'compile' | 'clean';

export interface BuildRequest {
  target?: string;
  /** Rebuild everything. */
  force?: boolean;
}

export interface BuildApi {
  make(req?: BuildRequest): Promise<BuildResultInfo>;
  bringUpToDate(req?: BuildRequest): Promise<BuildResultInfo>;
  /** Compile the named project files (Project > Compile). */
  compile(names: string[], req?: BuildRequest): Promise<BuildResultInfo>;
  /** Stop Build. Resolves once the running build has stopped (no-op when idle). */
  stop(): Promise<void>;
  /** Remove Object Code; returns removed paths. */
  removeObjectCode(req?: { target?: string; allTargets?: boolean }): Promise<string[]>;
  /** Whether a build is running. */
  isBuilding(): Promise<boolean>;
  /** Last result (Errors & Warnings window restore). */
  lastResult(): Promise<BuildResultInfo | null>;
}

export interface BuildEvents {
  started: { kind: BuildKind; target: string };
  progress: BuildProgressInfo;
  message: BuildMessageInfo;
  finished: BuildResultInfo;
}

export const BUILD_METHODS = ['make', 'bringUpToDate', 'compile', 'stop', 'removeObjectCode', 'isBuilding', 'lastResult'] as const;
