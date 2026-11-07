import { describe, it, expect } from 'vitest';
import { readFixture, describeFx, hasFixtures } from './fixtures';
import { readMcp, parseWizardXml, type McpGroupChild, type McpProject } from '../src/mcp';
import { LoocError, findChunk } from '../src/looc';

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

function simplify(children: McpGroupChild[]): unknown[] {
  return children.map((c) => (c.type === 'group' ? { [c.name]: simplify(c.children) } : c.name));
}

const LIVE_FILES = [
  'derivative.inc',
  'burner.bbl',
  'Project.prm',
  'mc9s12xdp512.inc',
  'Project.map',
  'ME305LibV4.0.lib',
  'main.asm',
];

function checkLab3Project(p: McpProject) {
  expect(p.warnings).toEqual([]);
  expect(p.subtitle).toBe('CodeWarrior Project');
  expect(p.targets.map((t) => t.name)).toEqual(['Standard']);
  const t = p.targets[0];

  // settings
  expect(t.settings.linker).toBe('Linker for HC12');
  expect(t.settings.outputDir).toBe('bin');
  expect(t.settings.outputFile).toBe('Project.abs');
  expect(t.settings.outputPath).toBe('bin\\Project.abs');

  // files: exactly the 7 live ones (the string tables also hold stale names of removed files and targets)
  expect(p.files.map((f) => f.name)).toEqual(LIVE_FILES);
  expect(t.files.map((f) => f.ref)).toEqual([0x01000002, 0x01000003, 0x01000004, 0x01000005, 0x01000006, 0x0100008b, 0x0100008e]);
  const kind = Object.fromEntries(p.files.map((f) => [f.name, f.kind]));
  expect(kind).toEqual({
    'derivative.inc': 'include',
    'burner.bbl': 'bbl',
    'Project.prm': 'prm',
    'mc9s12xdp512.inc': 'include',
    'Project.map': 'other',
    'ME305LibV4.0.lib': 'library',
    'main.asm': 'asm',
  });
  expect(p.files.find((f) => f.name === 'main.asm')!.tool).toBe('Assembler for HC12');
  expect(p.files.find((f) => f.name === 'ME305LibV4.0.lib')!.tool).toBe('Importer for HC12');
  expect(p.files.find((f) => f.name === 'ME305LibV4.0.lib')!.debug).toBe(false);
  expect(p.files.find((f) => f.name === 'main.asm')!.debug).toBe(true);

  // link order: lib before main
  expect(p.linkOrder).toEqual([
    'derivative.inc',
    'mc9s12xdp512.inc',
    'burner.bbl',
    'Project.prm',
    'Project.map',
    'ME305LibV4.0.lib',
    'main.asm',
  ]);
  expect(p.linkOrder.indexOf('ME305LibV4.0.lib')).toBeLessThan(p.linkOrder.indexOf('main.asm'));

  // group tree
  expect(simplify(p.groups)).toEqual([
    { Sources: ['main.asm'] },
    { Includes: ['derivative.inc', 'mc9s12xdp512.inc'] },
    { Libraries: ['ME305LibV4.0.lib'] },
    { 'Project Settings': [{ 'Linker Files': ['burner.bbl', 'Project.map', 'Project.prm'] }] },
  ]);
  const ids = p.groups.map((g) => (g.type === 'group' ? g.id : -1));
  expect(ids).toEqual([1, 2, 5, 3]);

  // tool options
  expect(t.toolOptions.assembler).toBe('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li');
  expect(t.toolOptions.compiler).toBe(' -CpuHCS12X ');
  expect(t.toolOptions.linker).toBe('');
  expect(t.toolOptions.burner).toBe('');
  expect(t.linkerPanel).toEqual({
    options: '',
    prmFile: 'out.prm',
    applicationFile: 'Project.abs',
    prmMode: 2,
    templatePrm: 'mc9s12xdp512.prm',
  });
  expect(Object.keys(t.toolPanels)).toHaveLength(12);
  expect(t.toolPanels['Assembler for HC12'].fields.map((f) => f.length)).toEqual([37, 0, 4, 4]);

  // build extras
  expect(t.buildExtras).toMatchObject({
    debuggerApp: '{Compiler}prog\\hiwave.exe',
    args: '%targetFilePath -Prod=%projectFileDir\\P&E_Multilink_USB.ini -instance=icd12',
    initialDir: '{Project}',
  });

  // access paths
  expect(t.accessPaths.user).toHaveLength(19);
  expect(t.accessPaths.user.slice(0, 8)).toEqual([
    '{Project}',
    '{Project}bin',
    '{Project}prm',
    '{Project}cmd',
    '{Project}Sources',
    '{Compiler}lib\\HC12c\\lib',
    '{Compiler}lib\\HC12c\\src',
    '{Project}Sources\\Libraries',
  ]);
  expect(t.accessPaths.user[18]).toMatch(/^[A-Z]:\\.+\\Sources$/); // an absolute path on a lab PC drive
  expect(t.accessPathRecords.user[18].root).toBe('absolute');
  expect(t.accessPaths.system).toEqual(['{Compiler}lib\\HC12c\\include']);

  // file mappings
  expect(t.fileMappings.map((s) => s.linker)).toEqual([
    'None',
    'External Build Linker',
    'Libmaker for HC12',
    'Linker for HC12',
    'Libmaker for XGATE',
    'Linker for XGATE',
    'PCLint Linker',
  ]);
  expect(t.activeFileMappings).toHaveLength(39);
  const m = (ext: string) => t.activeFileMappings.find((x) => x.extension === ext)!;
  expect(m('.asm')).toMatchObject({ fileType: 'TEXT', compiler: 'Assembler for HC12', flags: 0, ignoredByMake: false });
  expect(m('.inc')).toMatchObject({ compiler: 'Assembler for HC12', flags: 0x10, ignoredByMake: true });
  expect(m('.prm')).toMatchObject({ compiler: '', editLanguage: 'mwe_prm' });
  expect(m('.lib')).toMatchObject({ fileType: '', compiler: 'Importer for HC12' });
  expect(m('.pdf').flags).toBe(0x50);
  expect(m('.oil')).toMatchObject({ flags: 0xc0, precompile: true, launchable: true });

  // wizard
  expect(p.wizard).toMatchObject({
    version: '1.3',
    chip: 'MC9S12XDP512',
    language: 'Relocatable assembly',
    connection: 'P&E USB BDM Multilink',
  });
  expect(p.wizard!.xml.startsWith('<?xml version="1.0"?>')).toBe(true);
  expect(p.wizard!.elements).toHaveLength(10);
}

describeFx('readMcp', () => {
  it('decodes fixtures/Lab3/Lab3.mcp', () => {
    checkLab3Project(readMcp(u8(readFixture('Lab3', 'Lab3.mcp'))));
  });

  it('decodes fixtures/blank_project/blank_project.mcp identically', () => {
    const b = readFixture('blank_project', 'blank_project.mcp');
    expect(b.equals(readFixture('Lab3', 'Lab3.mcp'))).toBe(true);
    checkLab3Project(readMcp(u8(b)));
  });

  it('never derives targets from stale name strings', () => {
    const p = readMcp(u8(readFixture('Lab3', 'Lab3.mcp')));
    // the namespace-0 table still names an old target ("<old>:Source Trees"); it must not become a target
    expect(p.targets.map((t) => t.name)).toEqual(['Standard']);
  });

  it('drops group refs to unknown files with a warning', () => {
    const b = new Uint8Array(readFixture('Lab3', 'Lab3.mcp'));
    // PLst at 0xc531: first FILE node ('ELIF' at 0xc560) → ref 0x0100008E; corrupt it to 0x01000077
    expect(Buffer.from(b.subarray(0xc560, 0xc564)).toString('latin1')).toBe('ELIF');
    b[0xc564] = 0x77;
    const p = readMcp(b);
    expect(simplify(p.groups)[0]).toEqual({ Sources: [] });
    expect(p.warnings.some((w) => /unknown file 0x1000077/.test(w))).toBe(true);
  });
});

describe('parseWizardXml', () => {
  it('handles entities and missing elements', () => {
    const w = parseWizardXml('<WizardConfiguration version="2"><SelectedWizardElement name="Target" term="A&amp;B &#x41;" id="X" idrefs="a  b"/></WizardConfiguration>');
    expect(w.version).toBe('2');
    expect(w.connection).toBe('A&B A');
    expect(w.chip).toBeUndefined();
    expect(w.elements[0].idrefs).toEqual(['a', 'b']);
  });
});

describeFx('readMcp: review regressions', () => {
  const orig = u8(readFixture('Lab3', 'Lab3.mcp'));

  it('a truncated mtpi chunk gives a warning, not a RangeError (finding 3)', () => {
    const b = orig.slice();
    const p0 = readMcp(b);
    const mtpi = findChunk(p0.looc, 'mtpi', 1)!;
    const tableEntry = p0.looc.header.tableOff + mtpi.index * 24;
    new DataView(b.buffer).setUint32(tableEntry + 4, 2, true); // size 2
    const p = readMcp(b);
    expect(p.targets[0].files).toEqual([]);
    expect(p.warnings.some((w) => /mtpi too short/.test(w))).toBe(true);
  });

  it('deterministic fuzz: corrupted/truncated inputs only ever throw LoocError', () => {
    let seed = 0x1234567;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let n = 0; n < 400; n++) {
      let b = orig.slice();
      const mode = n % 3;
      if (mode === 0) b = b.slice(0, Math.floor(rnd() * b.length));
      const flips = 1 + Math.floor(rnd() * 16);
      for (let k = 0; k < flips; k++) {
        // bias corruption toward the chunk table (last 2 KiB), where it hurts most
        const at = mode === 2 ? b.length - 1 - Math.floor(rnd() * Math.min(2048, b.length)) : Math.floor(rnd() * b.length);
        if (at >= 0 && at < b.length) b[at] = Math.floor(rnd() * 256);
      }
      try {
        readMcp(b);
      } catch (e) {
        expect(e, `case ${n}: ${(e as Error).message}`).toBeInstanceOf(LoocError);
      }
    }
  });

  it('project files carry serial/refHigh/targets/refs (finding 9)', () => {
    const p = readMcp(orig);
    for (const f of p.files) {
      expect(f.refHigh).toBe(1);
      expect(f.serial).toBe(f.ref & 0xffffff);
      expect(f.targets).toEqual(['Standard']);
      expect(f.refs).toEqual([f.ref]);
    }
  });

  it('duplicate PLst leaves for the same file in one group collapse to one (finding 9)', () => {
    const p0 = readMcp(orig);
    const plst = p0.looc.chunks.find((c) => c.tag === 'PLst')!;
    const inc = p0.files.filter((f) => f.kind === 'include');
    expect(inc).toHaveLength(2);
    // find the FILE leaf for the second include and point it at the first
    const b = orig.slice();
    const dv = new DataView(b.buffer);
    let patched = 0;
    for (let o = plst.off; o + 8 <= plst.off + plst.size; o++) {
      if (String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) === 'ELIF' && dv.getUint32(o + 4, true) === inc[1].ref) {
        dv.setUint32(o + 4, inc[0].ref, true);
        patched++;
      }
    }
    expect(patched).toBe(1);
    const p = readMcp(b);
    const includes = p.groups.find((g) => g.type === 'group' && g.name === 'Includes');
    expect(includes && includes.type === 'group' && includes.children.map((c) => c.name)).toEqual([inc[0].name]);
  });
});
