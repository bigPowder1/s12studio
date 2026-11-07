import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { S12XSystem } from '@s12/sim';
import { DebugSymbols, MemoryFileSystem, SimTarget, type OutputLine, type TargetDebugInfo } from '@s12/debug';
import { addLab3Fakes } from '../../sim/test/fakes';
import { FIXTURES, hasFixtures } from '../../formats/test/fixtures';
export { hasFixtures, describeFx, itFx } from '../../formats/test/fixtures';

/** The private Lab3 fixture (with a trailing separator). */
export const LAB3_DIR = join(FIXTURES, 'Lab3') + '/';
/** Lab3's golden Project.abs (empty when the private fixtures are absent: guard with hasFixtures / describeFx). */
export const LAB3_ABS = hasFixtures ? new Uint8Array(readFileSync(join(LAB3_DIR, 'bin/Project.abs'))) : new Uint8Array(0);

/** Bare S12XSystem plus the sim test fakes (CRG PLL lock, ECT, SPI0 flags, ports) so Lab3 gets past startup. */
export function lab3System(): S12XSystem {
  const s = new S12XSystem();
  addLab3Fakes(s);
  s.reset();
  return s;
}

/** SimTarget with Lab3 loaded (PC at Entry $C000) and symbol-based debug info (main.dbg has source, the library not). */
export async function lab3Target(opts: ConstructorParameters<typeof SimTarget>[0] = {}): Promise<{ t: SimTarget; syms: DebugSymbols }> {
  const t = new SimTarget({ createSystem: lab3System, ...opts });
  await t.load({ kind: 'abs', data: LAB3_ABS });
  const syms = DebugSymbols.fromAbs(LAB3_ABS);
  t.setDebugInfo(symbolDebugInfo(syms));
  return { t, syms };
}

export function symbolDebugInfo(syms: DebugSymbols): TargetDebugInfo {
  return {
    lookup: (n) => syms.identValue(n),
    lineAt: (a) => syms.lineAt(a),
    hasSource: (a) => syms.lineAt(a)?.module === 'main.dbg',
  };
}

/** The Lab3 project tree (ini, layout, cmd/, bin/) copied into an in-memory file system under `root`. */
export function lab3Fs(root = '/proj'): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  const copy = (rel: string) => {
    const src = join(LAB3_DIR, rel);
    if (statSync(src).isDirectory()) for (const e of readdirSync(src)) copy(rel ? `${rel}/${e}` : e);
    else fs.files.set(`${root}/${rel}`, new Uint8Array(readFileSync(src)));
  };
  for (const e of readdirSync(LAB3_DIR)) if (/\.(ini|hwl)$/i.test(e) || e === 'cmd' || e === 'bin') copy(e);
  return fs;
}

export function collect(): { lines: OutputLine[]; push: (l: OutputLine) => void; texts: () => string[] } {
  const lines: OutputLine[] = [];
  return { lines, push: (l) => lines.push(l), texts: () => lines.map((l) => l.text) };
}
