/**
 * The demo project (examples/blinky, our own code, Apache-2.0) behind the startup dialog's "Load Example Project" and
 * Help > Open Demo Project. It ships read-only (<resources>/examples/blinky in an installed app, often under Program
 * Files or /Applications), so it is never opened in place: the first open copies it to
 * <Documents>/S12 Studio/Demo (blinky) and every later open reuses that copy (the student's edits survive).
 *
 * Source lookup: $S12_EXAMPLES_DIR/blinky, else <resources>/examples/blinky (packaged), else <repo>/examples/blinky.
 */
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ApiError } from '../../shared/api/common';

export const DEMO_NAME = 'blinky';
/** The demo's project file (a standalone S12 Studio project, no .mcp). */
export const DEMO_PROJECT_FILE = 'blinky.s12studio.json';
/** Folder of the writable copy under the user's Documents. */
export const DEMO_COPY_DIR = join('S12 Studio', `Demo (${DEMO_NAME})`);

export interface ExampleLocations {
  /** process.env (S12_EXAMPLES_DIR). */
  env: Record<string, string | undefined>;
  /** apps/ide in a checkout, <resources>/app.asar when packaged. */
  appDir: string;
  packaged: boolean;
  /** process.resourcesPath (packaged builds). */
  resourcesPath: string;
}

/** Path of the bundled demo's project file (it may not exist: the caller reports that). */
export function demoProjectSource(l: ExampleLocations): string {
  const examples = l.env.S12_EXAMPLES_DIR ? resolve(l.env.S12_EXAMPLES_DIR) : l.packaged ? join(l.resourcesPath, 'examples') : join(l.appDir, '../../examples');
  return join(examples, DEMO_NAME, DEMO_PROJECT_FILE);
}

/** Path of the writable copy's project file under `documentsDir`. */
export function demoProjectCopy(documentsDir: string): string {
  return join(documentsDir, DEMO_COPY_DIR, DEMO_PROJECT_FILE);
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Build outputs a checkout's examples/blinky may hold (examples/.gitignore): not part of the demo. */
const isBuildOutput = (name: string) => name === 'bin' || /_Data$/i.test(name);

/**
 * The demo's project file in a writable place: the existing copy when there is one, else a fresh copy of the bundled
 * demo (copied into a temporary sibling folder first and renamed, so an interrupted copy is never mistaken for a
 * complete one). Throws ApiError 'not-found' when the demo is not installed.
 */
export async function prepareDemoProject(source: string, documentsDir: string): Promise<string> {
  const target = demoProjectCopy(documentsDir);
  if (await exists(target)) return target;
  const srcDir = dirname(source);
  if (!(await exists(source))) throw new ApiError('not-found', `The demo project is not installed (${source})`);
  const dest = dirname(target);
  const tmp = `${dest}.partial-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  try {
    await cp(srcDir, tmp, { recursive: true, filter: (p) => p === srcDir || !isBuildOutput(basename(p)) });
    // a folder of that name without the project file (left over, emptied by the student): move it aside, keep it
    if (await exists(dest)) await rename(dest, `${dest} (old ${Date.now()})`);
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw new ApiError('io', `Could not copy the demo project to ${dest}: ${(e as Error).message}`);
  }
  return target;
}
