/**
 * Test data shaped like the ProjectInfo main produces for a Lab3-style .mcp project (structure as ProjectService.open
 * returns it; paths rebased to /p, sizes and the extra access path made up). Used by the IDE component tests.
 */
import type { ProjectFileInfo, ProjectInfo, TargetInfo } from '../../../shared/api';

const file = (name: string, kind: string, dir: string, extra: Partial<ProjectFileInfo> = {}): ProjectFileInfo => ({
  name,
  kind,
  tool: kind === 'asm' || kind === 'inc' ? 'Assembler for HC12' : kind === 'lib' ? 'Importer for HC12' : '',
  ignoredByMake: kind === 'inc' || kind === 'map',
  debug: kind !== 'lib',
  targets: ['Standard'],
  origin: 'mcp',
  path: `${dir}/${name}`,
  foundIn: dir.replace('/p/', '{Project}').replace('/cw/', '{Compiler}'),
  ...extra,
});

export function lab3Target(over: Partial<TargetInfo> = {}): TargetInfo {
  return {
    name: 'Standard',
    linker: 'Linker for HC12',
    outputDir: '{Project}bin',
    outputDirPath: '/p/bin',
    outputFile: 'Project.abs',
    absPath: '/p/bin/Project.abs',
    accessPaths: {
      user: [
        { display: '{Project}', path: '/p', exists: true },
        { display: '{Project}bin', path: '/p/bin', exists: true },
        { display: '{Project}prm', path: '/p/prm', exists: true },
        { display: '{Project}Sources', path: '/p/Sources', exists: true },
        { display: '{Project}..\\..\\SharedLibs', path: '/SharedLibs', exists: false },
      ],
      system: [{ display: '{Compiler}lib\\HC12c\\include', path: '/cw/lib/HC12c/include', exists: true }],
    },
    options: { assembler: '-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li', compiler: ' -CpuHCS12X ', linker: '', burner: '', importer: '', libmaker: '' },
    files: ['derivative.inc', 'burner.bbl', 'Project.prm', 'mc9s12xdp512.inc', 'Project.map', 'ME305LibV4.0.lib', 'main.asm'],
    linkOrder: ['derivative.inc', 'mc9s12xdp512.inc', 'burner.bbl', 'Project.prm', 'Project.map', 'ME305LibV4.0.lib', 'main.asm'],
    debugger: { app: '{Compiler}prog\\hiwave.exe', args: '%targetFilePath -Prod=%projectFileDir\\P&E_Multilink_USB.ini -instance=icd12', initialDir: '{Project}' },
    ...over,
  };
}

export function lab3Info(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    path: '/p/Lab3.mcp',
    mcpPath: '/p/Lab3.mcp',
    sidecarPath: '/p/Lab3.s12studio.json',
    dir: '/p',
    name: 'Lab3',
    currentTarget: 'Standard',
    targets: [lab3Target()],
    files: [
      file('derivative.inc', 'inc', '/p/Sources'),
      file('burner.bbl', 'bbl', '/p/prm'),
      file('Project.prm', 'prm', '/p/prm'),
      file('mc9s12xdp512.inc', 'inc', '/cw/lib/HC12c/include'),
      file('Project.map', 'map', '/p/bin'),
      file('ME305LibV4.0.lib', 'lib', '/p/Sources/Libraries', { code: 2000, data: 30 }),
      file('main.asm', 'asm', '/p/Sources', { touched: true, code: 812, data: 40 }),
    ],
    groups: [
      { type: 'group', name: 'Sources', children: [{ type: 'file', name: 'main.asm' }] },
      { type: 'group', name: 'Includes', children: [{ type: 'file', name: 'derivative.inc' }, { type: 'file', name: 'mc9s12xdp512.inc' }] },
      { type: 'group', name: 'Libraries', children: [{ type: 'file', name: 'ME305LibV4.0.lib' }] },
      {
        type: 'group',
        name: 'Project Settings',
        children: [{ type: 'group', name: 'Linker Files', children: [{ type: 'file', name: 'burner.bbl' }, { type: 'file', name: 'Project.map' }, { type: 'file', name: 'Project.prm' }] }],
      },
    ],
    connections: [
      { name: 'CyclonePro_USB', iniPath: '/p/CyclonePro_USB.ini', target: 'icd12' },
      { name: 'Full_Chip_Simulation', iniPath: '/p/Full_Chip_Simulation.ini', target: 'sim' },
      { name: 'P&E_Multilink_USB', iniPath: '/p/P&E_Multilink_USB.ini', target: 'icd12' },
    ],
    warnings: [],
    mcpChangedExternally: false,
    ...over,
  };
}
