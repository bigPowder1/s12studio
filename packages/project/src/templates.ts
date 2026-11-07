/**
 * New Project (PLAN.md M6, critique G4):
 *  - newProjectFromTemplate copies a CodeWarrior project tree (e.g. a copy of the course's blank_project the user put
 *    in the templates folder), renaming <tmpl>.mcp -> <name>.mcp and <tmpl>_Data -> <name>_Data (the .mcp does not
 *    store its own name);
 *  - newMinimalProject writes a generic MC9S12XDP512 relocatable-assembly project whose definition lives in a
 *    standalone sidecar (we never write .mcp files). All generated text is ours; no NXP template text is used.
 * S12 Studio ships no course content: course projects come from the user's own copy of the course folder.
 */
import { copyTree, latin1Bytes, utf8Bytes, type ProjectFs } from './fs';
import { SIDECAR_SUFFIX } from './model';
import { BUILD_CACHE_NAME } from './build';
import { baseName, extOf, joinPath, stemOf } from './paths';
import { emptySidecar, stringifySidecar, type BaseProject } from './sidecar';

export interface TemplateCopyOptions {
  /**
   * Skip build products of the template: bin/ outputs (.abs .map .s19 .glo .lst .dbg), <tmpl>_Data/<T>/ObjectCode
   * contents, our s12studio-build.json caches and CodeWarrior's TargetDataWindows*.tdt caches (which hold the
   * template's absolute paths; CodeWarrior rebuilds them). Default true.
   */
  clean?: boolean;
}

export interface NewProjectResult {
  /** path to open with openProject (.mcp, or the standalone sidecar) */
  projectPath: string;
  files: string[];
}

const BUILD_OUTPUT_EXTS = new Set(['.abs', '.map', '.s19', '.glo', '.lst', '.dbg']);

/**
 * Throw unless `name` is usable as a project (file) name on Windows, macOS and Linux: no path or reserved characters,
 * no control characters, no trailing dot or space, not a reserved DOS device name (CON, NUL, COM1, ... also with an
 * extension, e.g. "con.lab").
 */
export function validateProjectName(name: string): void {
  const bad =
    !name ||
    name.length > 200 ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^\s/.test(name) ||
    /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(name);
  if (bad) throw new Error(`invalid project name "${name}"`);
}

/** Is `dir` a CodeWarrior IDE data folder ('<project>_Data': CWSettings*.stg, or <Target>/ObjectCode or *.tdt)? */
async function isIdeDataDir(fs: ProjectFs, dir: string): Promise<boolean> {
  const names = (await fs.readdir(dir)) ?? [];
  if (names.some((n) => /^CWSettings.*\.stg$/i.test(n))) return true;
  for (const n of names) {
    const sub = await fs.readdir(joinPath(dir, n));
    if (sub?.some((x) => x.toLowerCase() === 'objectcode' || /\.tdt$/i.test(x) || x.toLowerCase() === BUILD_CACHE_NAME)) return true;
  }
  return false;
}

async function assertEmpty(fs: ProjectFs, dir: string): Promise<void> {
  const names = await fs.readdir(dir);
  if (names && names.length) throw new Error(`destination ${dir} is not empty`);
}

/** Copy a CodeWarrior project template into `destDir` as project `name`. */
export async function newProjectFromTemplate(fs: ProjectFs, templateDir: string, destDir: string, name: string, opts: TemplateCopyOptions = {}): Promise<NewProjectResult> {
  validateProjectName(name);
  await assertEmpty(fs, destDir);
  const names = (await fs.readdir(templateDir)) ?? [];
  const mcps = names.filter((n) => extOf(n) === '.mcp');
  const sidecars = names.filter((n) => n.toLowerCase().endsWith(SIDECAR_SUFFIX));
  if (mcps.length > 1) throw new Error(`template ${templateDir} contains several .mcp files`);
  const tmplFile = mcps[0] ?? sidecars[0];
  if (!tmplFile) throw new Error(`template ${templateDir} contains no .mcp`);
  const tmpl = mcps[0] ? stemOf(mcps[0]) : tmplFile.slice(0, -SIDECAR_SUFFIX.length);
  const clean = opts.clean ?? true;
  const lc = (s: string) => s.toLowerCase();
  // IDE data folders of older project names (e.g. Lab3_2C_Data next to Lab3.mcp) hold that project's caches; a user
  // folder that merely ends in "_data" (sensor_data) is copied.
  const staleData = new Set<string>();
  for (const n of names) {
    if (/_data$/i.test(n) && lc(n) !== lc(`${tmpl}_Data`) && (await fs.stat(joinPath(templateDir, n)))?.isDirectory && (await isIdeDataDir(fs, joinPath(templateDir, n)))) staleData.add(n);
  }

  const files = await copyTree(fs, templateDir, destDir, (rel, isDir) => {
    const segs = rel.split('/');
    const top = segs[0];
    if (segs.length === 1 && !isDir) {
      if (lc(top) === lc(`${tmpl}.mcp`)) return `${name}.mcp`;
      if (lc(top) === lc(tmpl + SIDECAR_SUFFIX)) return name + SIDECAR_SUFFIX;
    }
    let out = segs;
    if (lc(top) === lc(`${tmpl}_Data`)) out = [`${name}_Data`, ...segs.slice(1)];
    else if (staleData.has(top)) return undefined;
    if (clean && !isDir) {
      const ext = extOf(rel);
      if (lc(top) === 'bin' && segs.length === 2 && BUILD_OUTPUT_EXTS.has(ext)) return undefined;
      if (out[0] === `${name}_Data` && segs.some((s) => lc(s) === 'objectcode')) return undefined;
      if (out[0] === `${name}_Data` && ext === '.tdt') return undefined;
      if (out[0] === `${name}_Data` && lc(baseName(rel)) === BUILD_CACHE_NAME) return undefined;
    }
    return out.join('/');
  });
  const projectPath = joinPath(destDir, mcps[0] ? `${name}.mcp` : name + SIDECAR_SUFFIX);
  return { projectPath, files };
}

// ------------------------------------------------------------------------------------------------ generic template

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

export function minimalMainAsm(name: string): string {
  return crlf([
    ';******************************************************************************',
    `;* ${name}: main program`,
    ';* MC9S12XDP512, relocatable assembly. Created by S12 Studio.',
    ';******************************************************************************',
    '',
    '            XDEF    Entry, main',
    '            XREF    __SEG_END_SSTACK      ; top of the stack, set by the linker',
    '',
    "            INCLUDE 'derivative.inc'",
    '',
    ';------------------------------------------------------------------------------',
    '; variables',
    ';------------------------------------------------------------------------------',
    'DEFAULT_RAM: SECTION',
    'counter:    DS.W    1',
    '',
    ';------------------------------------------------------------------------------',
    '; code',
    ';------------------------------------------------------------------------------',
    'MyCode:     SECTION',
    'Entry:',
    'main:       LDS     #__SEG_END_SSTACK     ; set up the stack',
    '            CLI                           ; enable interrupts',
    '            MOVW    #0, counter',
    'loop:       LDD     counter',
    '            ADDD    #1',
    '            STD     counter',
    '            BRA     loop',
  ]);
}

export function minimalDerivativeInc(): string {
  return crlf([
    '; derivative.inc: register definitions of the target derivative',
    '',
    "            INCLUDE 'mc9s12xdp512.inc'",
  ]);
}

/** Linker parameter file: non-paged RAM/flash of the MC9S12XDP512 (memory map from the device datasheet). */
export function minimalPrm(): string {
  return crlf([
    '/* Linker parameter file for the MC9S12XDP512 (non-paged memory only). Created by S12 Studio. */',
    '',
    'NAMES',
    '    /* object files and libraries are passed by the IDE */',
    'END',
    '',
    'SEGMENTS',
    '    RAM       = READ_WRITE  DATA_NEAR             0x2000 TO 0x3FFF;',
    '    ROM_4000  = READ_ONLY   DATA_NEAR IBCC_NEAR   0x4000 TO 0x7FFF;',
    '    ROM_C000  = READ_ONLY   DATA_NEAR IBCC_NEAR   0xC000 TO 0xFEFF;',
    'END',
    '',
    'PLACEMENT',
    '    _PRESTART, STARTUP, ROM_VAR, STRINGS, NON_BANKED, COPY   INTO ROM_C000;',
    '    DEFAULT_ROM, MyCode                                       INTO ROM_4000;',
    '    SSTACK, DEFAULT_RAM                                       INTO RAM;',
    'END',
    '',
    'STACKSIZE 0x100',
    '',
    'VECTOR 0 Entry   /* reset vector */',
    'INIT Entry',
  ]);
}

/** Burner script: one S19 of the logical 64 KB address space (records of 32 bytes). */
export function minimalBbl(): string {
  return crlf([
    '/* S-record file of the application (logical addresses). Created by S12 Studio. */',
    'OPENFILE "%ABS_FILE%.s19"',
    'format = motorola',
    'busWidth = 1',
    'SRECORD = Sx',
    'origin = 0x0000',
    'len = 0x10000',
    'destination = 0',
    'SENDBYTE 1 "%ABS_FILE%"',
    'CLOSE',
  ]);
}

export function minimalFcsIni(): string {
  return crlf([
    '[Environment Variables]',
    'GENPATH={Project}Sources;{Compiler}lib\\hc12c\\include',
    'LIBPATH={Compiler}lib\\hc12c\\include',
    'OBJPATH={Project}bin',
    'TEXTPATH={Project}bin',
    'ABSPATH={Project}bin',
    '',
    '[HI-WAVE]',
    'Target=sim',
    'Layout=ASM_layout.hwl',
    'LoadDialogOptions=AUTOERASEANDFLASH NORUNAFTERLOAD',
    'CPU=HC12',
    '',
    '[Simulator]',
    'CMDFILE0=CMDFILE STARTUP ON ".\\cmd\\Full_Chip_Simulation_startup.cmd"',
    '',
    '[Simulator HC12]',
    'CMDFILE0=CMDFILE RESET ON ".\\cmd\\Full_Chip_Simulation_reset.cmd"',
    'CMDFILE1=CMDFILE PRELOAD ON ".\\cmd\\Full_Chip_Simulation_preload.cmd"',
    'CMDFILE2=CMDFILE POSTLOAD ON ".\\cmd\\Full_Chip_Simulation_postload.cmd"',
    'CMDFILE3=CMDFILE SETCPU ON ".\\cmd\\Full_Chip_Simulation_setcpu.cmd"',
    'HCS12_SUPPORT=2',
    'FCS=MC9S12XDP512',
    'HCS12X_FLASH=524288',
    'XGATE_RAM=32768',
  ]);
}

export function minimalLayoutHwl(): string {
  return crlf([
    'OPEN source 0 0 60 42',
    'Source < attributes MARKS off',
    'OPEN assembly 60 0 40 30',
    'Assembly < attributes ADR on,CODE off,ABSADR on,SYMB off,TOPPC 0x4000',
    'OPEN register 60 30 40 30',
    'OPEN procedure 60 60 40 17',
    'OPEN memory 60 77 40 23',
    'Memory < attributes FORMAT hex,WORD 1,ASC on,ADR on,MODE automatic,UPDATERATE 10,ADDRESS 0x80',
    'OPEN data 0 42 60 28',
    'Data < attributes SCOPE global,FORMAT Symb,MODE periodical,UPDATERATE 1',
    'OPEN command 0 70 60 30',
    'AUTOSIZE on',
  ]);
}

const CMD_STUBS: [string, string][] = [
  ['startup', 'executed when the debugger starts'],
  ['reset', 'executed after a reset'],
  ['preload', 'executed before an application is loaded'],
  ['postload', 'executed after an application is loaded'],
  ['setcpu', 'executed when the CPU is selected'],
];

/** Definition of the generic project (one "Standard" target, the Cal Poly access-path layout). */
export function minimalBaseProject(): BaseProject {
  const files: BaseProject['files'] = [
    { name: 'main.asm', kind: 'asm', tool: 'Assembler for HC12', ignoredByMake: false, debug: true },
    { name: 'derivative.inc', kind: 'inc', tool: 'Assembler for HC12', ignoredByMake: true, debug: true },
    { name: 'Project.prm', kind: 'prm', tool: '', ignoredByMake: false, debug: true },
    { name: 'burner.bbl', kind: 'bbl', tool: '', ignoredByMake: false, debug: true },
    { name: 'Project.map', kind: 'map', tool: '', ignoredByMake: true, debug: true },
  ];
  return {
    targets: [
      {
        name: 'Standard',
        linker: 'Linker for HC12',
        outputDir: '{Project}bin',
        outputFile: 'Project.abs',
        accessPaths: {
          user: ['{Project}', '{Project}bin', '{Project}prm', '{Project}cmd', '{Project}Sources', '{Compiler}lib\\HC12c\\lib', '{Compiler}lib\\HC12c\\src', '{Project}Sources\\Libraries'],
          system: ['{Compiler}lib\\HC12c\\include'],
        },
        options: { assembler: '-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li' },
        files: files.map((f) => f.name),
        linkOrder: ['derivative.inc', 'burner.bbl', 'Project.prm', 'Project.map', 'main.asm'],
        debugger: { app: '{Compiler}prog\\hiwave.exe', args: '%targetFilePath -Prod=%projectFileDir\\Full_Chip_Simulation.ini -instance=sim', initialDir: '{Project}' },
      },
    ],
    files,
    groups: [
      { type: 'group', name: 'Sources', children: [{ type: 'file', name: 'main.asm' }] },
      { type: 'group', name: 'Includes', children: [{ type: 'file', name: 'derivative.inc' }] },
      {
        type: 'group',
        name: 'Project Settings',
        children: [{ type: 'group', name: 'Linker Files', children: ['burner.bbl', 'Project.map', 'Project.prm'].map((name) => ({ type: 'file' as const, name })) }],
      },
    ],
    wizard: { chip: 'MC9S12XDP512', language: 'Relocatable assembly', connection: 'Full Chip Simulation' },
  };
}

/** Write the generated support files and `main.asm`, plus the standalone sidecar. */
async function writeGeneratedProject(
  fs: ProjectFs,
  destDir: string,
  name: string,
  opts: { mainAsm: Uint8Array; prm: string; bbl: string; base: BaseProject },
): Promise<NewProjectResult> {
  const text: [string, string][] = [
    ['Sources/derivative.inc', minimalDerivativeInc()],
    ['prm/Project.prm', opts.prm],
    ['prm/burner.bbl', opts.bbl],
    ['Full_Chip_Simulation.ini', minimalFcsIni()],
    ['ASM_layout.hwl', minimalLayoutHwl()],
    ...CMD_STUBS.map(([n, what]): [string, string] => [`cmd/Full_Chip_Simulation_${n[0].toUpperCase()}${n.slice(1)}.cmd`, crlf([`// Commands written below are ${what}`])]),
  ];
  const files: string[] = [];
  const put = async (rel: string, bytes: Uint8Array) => {
    const p = joinPath(destDir, rel);
    await fs.writeFile(p, bytes);
    files.push(p);
  };
  await put('Sources/main.asm', opts.mainAsm);
  for (const [rel, t] of text) await put(rel, latin1Bytes(t));
  await fs.mkdirp(joinPath(destDir, 'bin'));
  await fs.mkdirp(joinPath(destDir, `${name}_Data`, 'Standard', 'ObjectCode'));
  const sc = emptySidecar();
  sc.base = opts.base;
  sc.currentTarget = 'Standard';
  const projectPath = joinPath(destDir, name + SIDECAR_SUFFIX);
  await fs.writeFile(projectPath, utf8Bytes(stringifySidecar(sc)));
  files.push(projectPath);
  return { projectPath, files };
}

/** Generic MC9S12XDP512 relocatable-assembly project (standalone sidecar, Full Chip Simulation connection). */
export async function newMinimalProject(fs: ProjectFs, destDir: string, name: string): Promise<NewProjectResult> {
  validateProjectName(name);
  await assertEmpty(fs, destDir);
  return writeGeneratedProject(fs, destDir, name, { mainAsm: latin1Bytes(minimalMainAsm(name)), prm: minimalPrm(), bbl: minimalBbl(), base: minimalBaseProject() });
}
