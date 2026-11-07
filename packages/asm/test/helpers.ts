import { readFileSync } from 'node:fs';
import { fixture } from '../../formats/test/fixtures';
export { hasFixtures, describeFx, itFx } from '../../formats/test/fixtures';
import {
  decodeCwCompileUnit,
  noteDescString,
  parseHiwareNotes,
  readElf,
  readRelocationSections,
  type ElfFile,
} from '@s12/formats';
import { assemble, type AssembleInput, type AssembleResult } from '../src/index.js';

/** readFile over a fixture project directory (paths relative to the project, either slash). */
export function projectReader(project: string): (p: string) => Uint8Array | undefined {
  return (p: string) => {
    try {
      return new Uint8Array(readFileSync(fixture(project, p.replace(/\\/g, '/'))));
    } catch {
      return undefined;
    }
  };
}

export const LAB_OPTIONS = '-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li';

/** Note metadata, comp_dir and .dbg path recovered from a golden CodeWarrior object. */
export function goldenMeta(obj: Uint8Array): { user: string; time: string; commandLine: string; compDir: string; dbgPath: string } {
  const elf = readElf(obj);
  const notes = parseHiwareNotes(elf.sections.find((s) => s.name === '.note')!.data).notes;
  const nd = (t: number) => noteDescString(notes.find((n) => n.type === t)!.desc);
  const g = (n: string) => elf.sections.find((s) => s.name === n)!.data;
  const rel = (n: string) => readRelocationSections(elf).find((r) => elf.sections[r.target].name === n)?.relocs ?? [];
  const cu = decodeCwCompileUnit({
    info: g('.debug_info'),
    abbrev: g('.debug_abbrev'),
    line: g('.debug_line'),
    infoRelocs: rel('.debug_info'),
    lineRelocs: rel('.debug_line'),
  });
  return { user: nd(5), time: nd(7).replace(/\n$/, ''), commandLine: nd(9), compDir: cu.compDir, dbgPath: cu.lineFile };
}

/** Assemble an in-memory source (single file plus optional extra files). */
export function asmSource(src: string, options = '-CpuHCS12X -L', files: Record<string, string> = {}, extra: Partial<AssembleInput> = {}): AssembleResult {
  return assemble({
    sourcePath: 'C:\\proj\\Sources\\t.asm',
    readFile: (p) => {
      if (p === 'C:\\proj\\Sources\\t.asm') return src;
      const k = Object.keys(files).find((f) => f.toLowerCase() === p.toLowerCase() || p.toLowerCase().endsWith('\\' + f.toLowerCase()));
      return k !== undefined ? files[k] : undefined;
    },
    options,
    env: { TEXTPATH: 'C:\\proj\\bin', OBJPATH: 'C:\\proj\\bin' },
    ...extra,
  });
}

/** Bytes of a section of the assembled object. */
export function sectionBytes(r: AssembleResult, name: string): number[] {
  const s = r.object?.sections.find((x) => x.name === name);
  return s ? [...s.data] : [];
}

export function elfSection(elf: ElfFile, name: string) {
  return elf.sections.find((s) => s.name === name);
}

export const hex = (b: number[] | Uint8Array): string => [...b].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** The listing body lines (page headers removed), without CRLF. */
export function listingBody(text: string): string[] {
  const lines = text.split('\r\n');
  lines.pop();
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] === '' || lines[i].startsWith('\f')) && lines[i + 1] === 'Freescale HC12-Assembler ') {
      i += 5;
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}
