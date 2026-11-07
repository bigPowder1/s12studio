// CodeWarrior 5.x .mcp project reader (read-only). Spec: docs/research/r2/mcp-format.md §2, §5.
// Everything is reached through the looc chunk table; free space (stale strings, old PLst copies) is never scanned.
import { chunkReader, findChunk, readLooc, type LoocChunk, type LoocFile, type LoocReader } from '../looc/container';
import { LOOC_NS_ATOMS, LOOC_NS_NAMES, namedChunks, readStringTable } from '../looc/strings';
import { decodeGroupTree, type McpGroupChild, type McpGroupNode } from './groups';
import {
  blobString,
  blobU32,
  decodeAccessPaths,
  decodeBuildExtras,
  decodeFieldBlob,
  decodeFileMappings,
  decodeTargetSettings,
  type McpAccessPaths,
  type McpBuildExtras,
  type McpFieldBlob,
  type McpFileMapping,
  type McpFileMappingSection,
  type McpRootedPath,
  type McpTargetSettings,
} from './panels';
import { parseWizardXml, type McpWizard } from './wizard';

export type McpFileKind = 'asm' | 'c' | 'library' | 'include' | 'prm' | 'bbl' | 'other';

export interface McpFile {
  /** file reference as stored in mtpl/mtlo/PLst, e.g. 0x01000004 */
  ref: number;
  /** ref & 0xFFFFFF — the file serial */
  serial: number;
  /**
   * ref >>> 24 (1 in Lab3). UNCERTAIN: mcp-format.md reads it as an object-kind byte (0x01 = file), ide.md §8 as the
   * 1-based target number (`fileIdx | target<<24`). Single-target fixtures cannot tell them apart.
   */
  refHigh: number;
  /** leaf file name (no path; resolved via access paths) */
  name: string;
  /** ns-0x3E8 atom id of the name */
  atom: number;
  kind: McpFileKind;
  /** tool from the target's file mapping, e.g. "Assembler for HC12" ('' if none) */
  tool: string;
  ignoredByMake: boolean;
  /** UNCERTAIN: u16 at +0x12 of the mtpl record, 1 for sources and 0 for the .lib ("Debug" column) */
  debug: boolean;
  /** raw 40-byte mtpl record */
  raw: Uint8Array;
}

export interface McpToolOptions {
  assembler?: string;
  compiler?: string;
  linker?: string;
  burner?: string;
  importer?: string;
  libmaker?: string;
}

export interface McpLinkerPanel {
  options: string;
  /** field1, e.g. "out.prm". UNCERTAIN meaning */
  prmFile: string;
  /** field4: application file name, e.g. "Project.abs" */
  applicationFile: string;
  /** field5 u32 (2 in Lab3). UNCERTAIN: probably "use PRM file in project" */
  prmMode?: number;
  /** field6: template PRM, e.g. "mc9s12xdp512.prm" */
  templatePrm: string;
}

export interface McpTarget {
  name: string;
  /** index in the target list (0-based) */
  index: number;
  settings: {
    linker: string;
    preLinker: string;
    postLinker: string;
    /** output directory as displayed, e.g. "bin" ({Project}-relative paths shown bare) */
    outputDir: string;
    outputDirPath?: McpRootedPath;
    /** application file name from the linker panel, e.g. "Project.abs" */
    outputFile: string;
    /** project-relative output path, e.g. "bin\\Project.abs" */
    outputPath: string;
    raw?: McpTargetSettings;
  };
  /** display strings, e.g. "{Project}", "{Project}bin", "{Compiler}lib\\HC12c\\include" */
  accessPaths: { user: string[]; system: string[] };
  accessPathRecords: McpAccessPaths;
  buildExtras?: {
    /** display string, e.g. "{Compiler}prog\\hiwave.exe" */
    debuggerApp: string;
    args: string;
    initialDir: string;
    raw: McpBuildExtras;
  };
  /** HC12 tool panel field0 (extra command-line options) */
  toolOptions: McpToolOptions;
  /** XGATE tool panel field0 */
  xgateToolOptions: McpToolOptions;
  linkerPanel?: McpLinkerPanel;
  /** decoded "Panel for <Tool> for <CPU>" blobs keyed by "<Tool> for <CPU>" */
  toolPanels: Record<string, McpFieldBlob>;
  fileMappings: McpFileMappingSection[];
  /** the mapping section whose linker matches settings.linker */
  activeFileMappings: McpFileMapping[];
  files: McpFile[];
  linkOrder: string[];
  linkOrderRefs: number[];
  /** raw panel chunks keyed by panel name (without the "<Target>:" prefix) */
  panels: Record<string, LoocChunk>;
}

/** A file in the project-wide list: one entry per distinct file, however many targets contain it. */
export interface McpProjectFile extends McpFile {
  /** names of the targets whose file table lists this file, in target order */
  targets: string[];
  /** every ref this file appears under (one per target if refs are target-qualified) */
  refs: number[];
}

export interface McpProject {
  subtitle: string;
  endianness: 'le' | 'be';
  targets: McpTarget[];
  /**
   * union of all targets' files (first target first), deduplicated by (serial, name atom) so a file shared by several
   * targets appears once. UNCERTAIN for multi-target projects (no fixture).
   */
  files: McpProjectFile[];
  /** link order of the first target, by leaf name */
  linkOrder: string[];
  /** project group tree (children of the ROOT node) */
  groups: McpGroupChild[];
  groupTree?: McpGroupNode;
  wizard?: McpWizard;
  warnings: string[];
  looc: LoocFile;
}

const TOOL_KEYS: [keyof McpToolOptions, string][] = [
  ['assembler', 'Assembler'],
  ['compiler', 'Compiler'],
  ['linker', 'Linker'],
  ['burner', 'Burner'],
  ['importer', 'Importer'],
  ['libmaker', 'Libmaker'],
];

const EXT_KIND: Record<string, McpFileKind> = {
  asm: 'asm', s: 'asm', a12: 'asm',
  c: 'c', h: 'include', inc: 'include', equ: 'include',
  lib: 'library', o: 'library', obj: 'library', a: 'library', elf: 'library', abs: 'library',
  prm: 'prm', bbl: 'bbl',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function classify(name: string, mappings: McpFileMapping[]): { kind: McpFileKind; tool: string; ignoredByMake: boolean } {
  const ext = extOf(name);
  const m = mappings.find((x) => x.extension.toLowerCase() === ext);
  const fallback = EXT_KIND[ext.slice(1)] ?? 'other';
  if (!m) return { kind: fallback, tool: '', ignoredByMake: false };
  let kind: McpFileKind;
  if (m.editLanguage === 'mwe_prm') kind = 'prm';
  else if (m.editLanguage === 'mwe_bbl') kind = 'bbl';
  else if (/^Importer\b/.test(m.compiler)) kind = 'library';
  else if (/^Assembler\b/.test(m.compiler)) kind = m.ignoredByMake ? 'include' : 'asm';
  else if (/^Compiler\b/.test(m.compiler)) kind = m.ignoredByMake ? 'include' : 'c';
  else kind = fallback === 'prm' || fallback === 'bbl' ? fallback : 'other';
  return { kind, tool: m.compiler, ignoredByMake: m.ignoredByMake };
}

interface MtglTarget { nameAtom: number; outputAtom: number; modTime: number }

// UNCERTAIN: mtgl record layout. Lab3 has count=1, cap=4 and a 532-byte record area (4 × 133 bytes).
function decodeMtgl(r: LoocReader, size: number, warnings: string[]): MtglTarget[] {
  if (size < 8) return [];
  const count = r.u32(0), cap = r.u32(4);
  const recSize = cap > 0 ? Math.floor((size - 8) / cap) : 0;
  const out: MtglTarget[] = [];
  for (let i = 0; i < count; i++) {
    const o = 8 + i * recSize;
    if (recSize < 0x18 || o + 0x18 > size) {
      warnings.push('mtgl target record out of range');
      break;
    }
    out.push({ nameAtom: r.u16(o + 0x0c), outputAtom: r.u32(o + 0x10), modTime: r.u32(o + 0x14) });
  }
  return out;
}

function emptyTarget(name: string, index: number): McpTarget {
  return {
    name,
    index,
    settings: { linker: '', preLinker: '', postLinker: '', outputDir: '', outputFile: '', outputPath: '' },
    accessPaths: { user: [], system: [] },
    accessPathRecords: { user: [], system: [] },
    toolOptions: {},
    xgateToolOptions: {},
    toolPanels: {},
    fileMappings: [],
    activeFileMappings: [],
    files: [],
    linkOrder: [],
    linkOrderRefs: [],
    panels: {},
  };
}

const stripProject = (p: McpRootedPath) => (p.root === 'project' ? p.path : p.display);

export function readMcp(bytes: Uint8Array): McpProject {
  const looc = readLooc(bytes);
  const warnings: string[] = [...looc.warnings];
  if (looc.subtitle !== 'CodeWarrior Project') warnings.push(`unexpected container subtitle ${JSON.stringify(looc.subtitle)}`);
  const names = readStringTable(looc, LOOC_NS_NAMES, warnings);
  const atoms = readStringTable(looc, LOOC_NS_ATOMS, warnings);
  if (!names) warnings.push('namespace-0 string table missing');
  if (!atoms) warnings.push('atom string table (ns 0x3E8) missing');
  const atom = (id: number) => atoms?.strings.get(id);
  const named = namedChunks(looc, names, warnings);

  // ---- targets: names that actually own 'pref' chunks, ordered by mtgl
  const prefTargets: string[] = [];
  for (const [name, c] of named) {
    if (c.tag !== 'pref') continue;
    const i = name.indexOf(':');
    if (i <= 0) continue;
    const t = name.slice(0, i);
    if (!prefTargets.includes(t)) prefTargets.push(t);
  }
  const mtglChunk = findChunk(looc, 'mtgl');
  const mtgl = mtglChunk ? decodeMtgl(chunkReader(looc, mtglChunk), mtglChunk.size, warnings) : [];
  const ordered: { name: string; mt?: MtglTarget }[] = [];
  for (const mt of mtgl) {
    const n = atom(mt.nameAtom);
    if (n === undefined) {
      warnings.push(`mtgl names unknown atom ${mt.nameAtom}`);
      continue;
    }
    if (!prefTargets.includes(n)) warnings.push(`target "${n}" listed in mtgl has no settings panels`);
    ordered.push({ name: n, mt });
  }
  for (const t of prefTargets) {
    if (!ordered.some((o) => o.name === t)) {
      if (mtglChunk) warnings.push(`target "${t}" has panels but is not in mtgl`);
      ordered.push({ name: t });
    }
  }

  const decodeTarget = ({ name, mt }: { name: string; mt?: MtglTarget }, index: number): McpTarget => {
    const panels: Record<string, LoocChunk> = {};
    for (const [n, c] of named) if (n.startsWith(name + ':')) panels[n.slice(name.length + 1)] = c;
    const rd = (c: LoocChunk) => chunkReader(looc, c);
    const tw = (msg: string) => warnings.push(`${name}: ${msg}`);
    const tWarn: string[] = [];

    const ts = panels['Target Settings'] ? decodeTargetSettings(rd(panels['Target Settings']), panels['Target Settings'].size, tWarn) : undefined;
    if (ts && ts.targetName !== name) tw(`Target Settings name "${ts.targetName}" differs from panel prefix`);
    const ap = panels['Access Paths'] ? decodeAccessPaths(rd(panels['Access Paths']), panels['Access Paths'].size, tWarn) : { user: [], system: [] };
    const fm = panels['File Mappings'] ? decodeFileMappings(rd(panels['File Mappings']), panels['File Mappings'].size, tWarn) : [];
    const be = panels['Build Extras'] ? decodeBuildExtras(rd(panels['Build Extras']), panels['Build Extras'].size, tWarn) : undefined;

    const toolPanels: Record<string, McpFieldBlob> = {};
    for (const [pn, c] of Object.entries(panels)) {
      const m = /^Panel for (.+)$/.exec(pn);
      if (!m) continue;
      const blob = decodeFieldBlob(rd(c), c.size, tWarn, pn);
      if (blob) toolPanels[m[1]] = blob;
    }
    const opts = (cpu: string): McpToolOptions => {
      const o: McpToolOptions = {};
      for (const [k, tool] of TOOL_KEYS) {
        const b = toolPanels[`${tool} for ${cpu}`];
        if (b) o[k] = b.options;
      }
      return o;
    };
    const lb = toolPanels['Linker for HC12'];
    const linkerPanel: McpLinkerPanel | undefined = lb && {
      options: lb.options,
      prmFile: blobString(lb, 1),
      applicationFile: blobString(lb, 4),
      prmMode: blobU32(lb, 5, looc.endianness === 'le'),
      templatePrm: blobString(lb, 6),
    };

    const linker = ts?.linker ?? '';
    const active = fm.find((s) => s.linker === linker)?.mappings ?? [];
    if (fm.length > 0 && active.length === 0) tw(`no file mapping section for linker "${linker}"`);

    // ---- files: first mtpi.count records of mtpl (ns = target index + 1; UNCERTAIN for multi-target projects)
    const ns = index + 1;
    const files: McpFile[] = [];
    const mtpi = findChunk(looc, 'mtpi', ns);
    const mtpl = findChunk(looc, 'mtpl', ns);
    if (mtpl) {
      const r = rd(mtpl);
      const cap = Math.floor(mtpl.size / 40);
      let count = mtpi && mtpi.size >= 4 ? rd(mtpi).u32(0) : 0;
      if (!mtpi) tw('mtpi missing; file list empty');
      else if (mtpi.size < 4) tw(`mtpi too short (${mtpi.size} bytes); file list empty`);
      if (count > cap) {
        tw(`mtpi count ${count} exceeds mtpl capacity ${cap}`);
        count = cap;
      }
      for (let i = 0; i < count; i++) {
        const o = i * 40;
        const ref = r.u32(o), a = r.u32(o + 4);
        const fname = atom(a);
        if (fname === undefined) {
          tw(`file record ${i} has unknown name atom ${a}`);
          continue;
        }
        files.push({ ref, serial: ref & 0xffffff, refHigh: ref >>> 24, name: fname, atom: a, ...classify(fname, active), debug: r.u16(o + 0x12) !== 0, raw: mtpl.data.slice(o, o + 40) });
      }
    } else tw('mtpl missing; file list empty');

    const byRef = new Map(files.map((f) => [f.ref, f]));
    const linkOrderRefs: number[] = [];
    const mtlo = findChunk(looc, 'mtlo', ns);
    if (mtlo) {
      const r = rd(mtlo);
      for (let o = 0; o + 4 <= mtlo.size; o += 4) {
        const ref = r.u32(o);
        if (byRef.has(ref)) linkOrderRefs.push(ref);
        else tw(`link order references unknown file 0x${ref.toString(16)}`);
      }
    }

    for (const w of tWarn) tw(w);
    const outputFile = linkerPanel?.applicationFile ?? '';
    const outputDir = ts ? stripProject(ts.outputDir) : '';
    const mtOut = mt ? atom(mt.outputAtom) : undefined;
    // UNCERTAIN: mtgl's output atom ("bin\\Project.abs") is preferred; otherwise join outputDir + application file.
    const outputPath = mtOut ?? (outputDir && outputFile ? `${outputDir}\\${outputFile}` : outputFile);

    return {
      name,
      index,
      settings: {
        linker,
        preLinker: ts?.preLinker ?? '',
        postLinker: ts?.postLinker ?? '',
        outputDir,
        outputDirPath: ts?.outputDir,
        outputFile,
        outputPath,
        raw: ts,
      },
      accessPaths: { user: ap.user.map((p) => p.display), system: ap.system.map((p) => p.display) },
      accessPathRecords: ap,
      buildExtras: be && {
        debuggerApp: be.debuggerApp.display,
        args: be.args,
        initialDir: be.initialDir.display,
        raw: be,
      },
      toolOptions: opts('HC12'),
      xgateToolOptions: opts('XGATE'),
      linkerPanel,
      toolPanels,
      fileMappings: fm,
      activeFileMappings: active,
      files,
      linkOrder: linkOrderRefs.map((r) => byRef.get(r)!.name),
      linkOrderRefs,
      panels,
    };
  };
  // A corrupt panel must not abort the whole project: decoder exceptions become warnings and an empty target.
  const targets: McpTarget[] = ordered.map((o, index) => {
    try {
      return decodeTarget(o, index);
    } catch (e) {
      warnings.push(`${o.name}: decode failed: ${(e as Error).message}`);
      return emptyTarget(o.name, index);
    }
  });

  // ---- project-wide file list and group tree
  const files: McpProjectFile[] = [];
  const fileByKey = new Map<string, McpProjectFile>();
  const fileByRef = new Map<number, McpProjectFile>();
  for (const t of targets) {
    for (const f of t.files) {
      const key = `${f.serial}:${f.atom}`;
      let pf = fileByKey.get(key);
      if (!pf) {
        pf = { ...f, targets: [], refs: [] };
        fileByKey.set(key, pf);
        files.push(pf);
      }
      if (!pf.targets.includes(t.name)) pf.targets.push(t.name);
      if (!pf.refs.includes(f.ref)) pf.refs.push(f.ref);
      if (!fileByRef.has(f.ref)) fileByRef.set(f.ref, pf);
    }
  }

  let groupTree: McpGroupNode | undefined;
  const plst = named.get('Project File List');
  if (plst) {
    const gt = decodeGroupTree(chunkReader(looc, plst), plst.size, warnings);
    if (gt) {
      const prune = (g: McpGroupNode) => {
        // ide.md §8: a file in several targets appears once per target in PLst; keep one leaf per project file.
        const seen = new Set<McpProjectFile>();
        g.children = g.children.filter((c) => {
          if (c.type === 'group') {
            prune(c);
            return true;
          }
          const f = fileByRef.get(c.ref);
          if (!f) {
            warnings.push(`group "${g.name}" references unknown file 0x${c.ref.toString(16)}; dropped`);
            return false;
          }
          if (seen.has(f)) return false;
          seen.add(f);
          c.name = f.name;
          return true;
        });
      };
      prune(gt.root);
      groupTree = gt.root;
    }
  } else warnings.push('Project File List (PLst) missing');

  let wizard: McpWizard | undefined;
  const prpl = named.get('HC12 Wizard Configuration');
  if (prpl) {
    let xml = '';
    for (let i = 0; i < prpl.data.length && prpl.data[i] !== 0; i++) xml += String.fromCharCode(prpl.data[i]);
    try {
      wizard = parseWizardXml(xml);
    } catch (e) {
      warnings.push(`HC12 Wizard Configuration: ${(e as Error).message}`);
    }
  }

  return {
    subtitle: looc.subtitle,
    endianness: looc.endianness,
    targets,
    files,
    linkOrder: targets[0]?.linkOrder ?? [],
    groups: groupTree?.children ?? [],
    groupTree,
    wizard,
    warnings,
    looc,
  };
}

