import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HiwareNoteType, noteDescString, parseHiwareNotes, readElf } from '@s12/formats';
import { readNoteMeta } from '@s12/link';
import { FIXTURES } from '../../formats/test/fixtures';
export { FIXTURES, hasFixtures, describeFx, itFx } from '../../formats/test/fixtures';
import { MemoryFs, installCompilerRoot, openProject, type BuildOptions, type Project } from '../src/index';

export const COMPILER = '/cw';

/** Copy a fixture project (read-only on disk) into the in-memory fs at `dest`. */
export function loadFixture(fs: MemoryFs, project: string, dest: string): void {
  const root = join(FIXTURES, project);
  const rec = (rel: string) => {
    for (const n of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(root, r)).isDirectory()) rec(r);
      else fs.writeSync(`${dest}/${r}`, new Uint8Array(readFileSync(join(root, r))));
    }
  };
  rec('');
}

export const goldenBytes = (project: string, rel: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, project, rel)));

export const DATA_DIR: Record<string, string> = { Lab3: 'Lab3_Data', blank_project: 'blank_project_Data' };
export const MCP: Record<string, string> = { Lab3: 'Lab3.mcp', blank_project: 'blank_project.mcp' };

/** Build outputs that the golden tests regenerate (relative to the project dir). */
export const OUTPUTS = (project: string) => [
  'bin/main.lst',
  'bin/main.dbg',
  'bin/Project.abs',
  'bin/Project.map',
  'bin/Project.abs.s19',
  'bin/Project.abs.glo',
  `${DATA_DIR[project]}/Standard/ObjectCode/main.asm.o`,
];

/** A fixture project in memory with its build outputs deleted, plus our compiler root. */
export async function freshProject(project: string, dest = `/work/${project}`): Promise<{ fs: MemoryFs; proj: Project; dir: string }> {
  const fs = new MemoryFs();
  loadFixture(fs, project, dest);
  for (const o of OUTPUTS(project)) await fs.remove(`${dest}/${o}`);
  await installCompilerRoot(fs, COMPILER);
  const proj = await openProject(fs, `${dest}/${MCP[project]}`, { compilerDir: COMPILER });
  return { fs, proj, dir: dest };
}

/** Build options reproducing the lab PC that produced the golden files (paths, user, time stamps). */
export function goldenBuildOptions(project: string): BuildOptions {
  const abs = goldenBytes(project, 'bin/Project.abs');
  const meta = readNoteMeta(abs)!;
  const map = Buffer.from(goldenBytes(project, 'bin/Project.map')).toString('latin1');
  const absPath = /PROGRAM "([^"]*)"/.exec(map)![1];
  const projectRoot = absPath.replace(/\\bin\\Project\.abs$/, '');
  const compilerRoot = /;([^;]*)\\lib\\HC12c\\lib;/.exec(meta.commandLine)![1];
  const obj = readElf(goldenBytes(project, `${DATA_DIR[project]}/Standard/ObjectCode/main.asm.o`));
  const notes = parseHiwareNotes(obj.sections.find((s) => s.name === '.note')!.data).notes;
  const asmTime = noteDescString(notes.find((n) => n.type === HiwareNoteType.Created)!.desc);
  return {
    toolRoots: { project: projectRoot, compiler: compilerRoot },
    user: meta.user,
    stamp: (tool) => (tool === 'assembler' ? asmTime : meta.created),
  };
}

export const latin1 = (b: Uint8Array | undefined): string => (b ? Buffer.from(b).toString('latin1') : '<missing>');
