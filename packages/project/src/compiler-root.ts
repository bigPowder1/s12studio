/**
 * Our bundled "{Compiler}" tool root: the directories a CodeWarrior S12(X) install provides that projects reference
 * through access paths ({Compiler}lib\HC12c\include, lib\HC12c\lib, lib\HC12c\src, prog). No NXP files are shipped:
 * mc9s12xdp512.inc is generated from the @s12/devices description.
 */
import { DEFAULT_DEVICE, generateIncFile, type DeviceDescription } from '@s12/devices';
import type { ProjectFs } from './fs';
import { latin1Bytes } from './fs';
import { joinPath } from './paths';

/** Directories of a CW install that the Cal Poly access paths name (they must exist to appear in GENPATH). */
export const COMPILER_ROOT_DIRS = ['lib/HC12c/include', 'lib/HC12c/lib', 'lib/HC12c/src', 'lib/xgatec/include', 'lib/xgatec/lib', 'lib/xgatec/src', 'prog'];

/**
 * Generic derivative.inc for the {Compiler} include directory. A project's own Sources/derivative.inc is found
 * first (user access paths precede system paths), so this only serves projects that lack one.
 */
export function derivativeIncText(device: DeviceDescription = DEFAULT_DEVICE): string {
  return [
    '; derivative.inc - selects the register definitions of the target derivative.',
    '; Provided by S12 Studio for projects that do not have their own copy.',
    '',
    `            INCLUDE '${device.name.toLowerCase()}.inc'`,
    '',
  ].join('\r\n');
}

/** Files of the bundled tool root, relative paths ('/' separators) to bytes. */
export function bundledCompilerFiles(device: DeviceDescription = DEFAULT_DEVICE): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  m.set(`lib/HC12c/include/${device.name.toLowerCase()}.inc`, latin1Bytes(generateIncFile(device)));
  m.set('lib/HC12c/include/derivative.inc', latin1Bytes(derivativeIncText(device)));
  return m;
}

/**
 * Create (or refresh) the bundled tool root in `dir`. Existing files are kept unless `overwrite`. Returns the paths
 * written.
 */
export async function installCompilerRoot(fs: ProjectFs, dir: string, opts: { overwrite?: boolean; device?: DeviceDescription } = {}): Promise<string[]> {
  const written: string[] = [];
  for (const d of COMPILER_ROOT_DIRS) await fs.mkdirp(joinPath(dir, d));
  for (const [rel, bytes] of bundledCompilerFiles(opts.device)) {
    const p = joinPath(dir, rel);
    if (!opts.overwrite && (await fs.exists(p))) continue;
    await fs.writeFile(p, bytes);
    written.push(p);
  }
  return written;
}
