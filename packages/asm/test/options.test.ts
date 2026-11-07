import { describe, expect, it } from 'vitest';
import { assemble } from '../src/index.js';
import { expandModifiers, parseOptions, tokenizeOptions } from '../src/index.js';

describe('option parsing', () => {
  it('parses the lab command line (as recorded in the golden .note)', () => {
    const cmd =
      '-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li -env"GENPATH=C:\\a b\\p;C:\\a b\\p\\Sources" -env"OBJPATH=C:\\a b\\p\\bin" ' +
      '-env"TEXTPATH=C:\\a b\\p\\bin" -objn"C:\\a b\\p\\p_Data\\Standard\\ObjectCode\\main.asm.o" ';
    const { options: o, problems } = parseOptions(cmd);
    expect(problems).toEqual([]);
    expect(o.cpu).toBe('HCS12X');
    expect(o.listing).toBe(true);
    expect(o.listingFile).toBe('%(TEXTPATH)\\%n.lst');
    expect(o.noIncludes).toBe(true);
    expect(o.env).toEqual({ GENPATH: 'C:\\a b\\p;C:\\a b\\p\\Sources', OBJPATH: 'C:\\a b\\p\\bin', TEXTPATH: 'C:\\a b\\p\\bin' });
    expect(o.objectFile).toBe('C:\\a b\\p\\p_Data\\Standard\\ObjectCode\\main.asm.o');
    expect(o.raw).toBe(cmd);
  });

  it('accepts the documented spellings and values', () => {
    const { options: o, problems } = parseOptions(
      '-CpuHCS12 -Lc -Ld -Le -Lasmc=rk -Lasms2 -DFOO -DBAR=$10 -DBAZ=0x20 -Ml -FA2 -Ci -CpDirect0x1100 -W2 -WmsgSd1104 -WmsgSeA2332 -IC:\\inc -Compat=c -MacroNest10 -NoBeep -Prod=x.ini',
    );
    // -FA2 is parsed but not implemented: one INFORMATION-class note (A9004), nothing else.
    expect(problems.map((p) => p.code)).toEqual(['A9004']);
    expect(o).toMatchObject({
      cpu: 'HCS12',
      noMacroCalls: true,
      noMacroDefs: true,
      noMacroExpansions: true,
      lasmc: 'rk',
      lasms: 2,
      defines: [
        { name: 'FOO', value: 0 },
        { name: 'BAR', value: 16 },
        { name: 'BAZ', value: 32 },
      ],
      memoryModel: 'LARGE',
      format: 'FA2',
      caseInsensitive: true,
      cpDirect: 0x1100,
      compat: 'c',
      macroNest: 10,
      includePaths: ['C:\\inc'],
      prod: 'x.ini',
    });
    expect(o.messages).toEqual({ warningLevel: 2, overrides: { A1104: 'DISABLE', A2332: 'ERROR' } });
  });

  it('accepts the lower-case spellings of the manual examples (-d, -l, -i)', () => {
    // Manual, option -D: "-dADD_COPYRIGHT -dYEAR=2005".
    const { options: o, problems } = parseOptions('-dADD_COPYRIGHT -dYEAR=2005 -l=%n.lst -iC:\\inc -li');
    expect(problems).toEqual([]);
    expect(o.defines).toEqual([
      { name: 'ADD_COPYRIGHT', value: 0 },
      { name: 'YEAR', value: 2005 },
    ]);
    expect(o.listing).toBe(true);
    expect(o.listingFile).toBe('%n.lst');
    expect(o.includePaths).toEqual(['C:\\inc']);
    expect(o.noIncludes).toBe(true);
    // -Lc/-Ld/-Le/-Lasm* are still told apart from -L(=file).
    const q = parseOptions('-lc -ld -le -lasms2 -lasmc=a').options;
    expect(q).toMatchObject({ noMacroCalls: true, noMacroDefs: true, noMacroExpansions: true, lasms: 2, lasmc: 'a' });
    expect(q.listingFile).toBeUndefined();
  });

  it('the -D example of the manual selects the IFDEF block with lower-case -d', () => {
    const src = ' IFDEF ADD_COPYRIGHT\r\n DC.B YEAR\r\n ENDIF\r\n';
    const r = assemble({ sourcePath: 'a.asm', readFile: () => src, options: '-dADD_COPYRIGHT -dYEAR=5' });
    expect(r.messages).toEqual([]);
    expect(Array.from(r.object!.sections.find((s) => s.name === '_SEC000000')!.data)).toEqual([5]);
  });

  it('reports -FA2/-Fh as unsupported (A9004 INFORMATION, no file) and SECTION under -FA2 as A2341', () => {
    const r = assemble({ sourcePath: 'a.asm', readFile: () => 'S: SECTION\r\n NOP\r\n', options: '-FA2' });
    expect(r.messages.map((m) => [m.code, m.severity, m.file])).toEqual([
      ['A9004', 'INFORMATION', ''],
      ['A2341', 'ERROR', 'a.asm'],
    ]);
    expect(r.ok).toBe(false);
    const org = assemble({ sourcePath: 'a.asm', readFile: () => ' ORG $4000\r\n NOP\r\n', options: '-FA2' });
    expect(org.ok).toBe(true);
    expect(parseOptions('-Fh').problems.map((p) => p.code)).toEqual(['A9004']);
    expect(parseOptions('-F2').problems).toEqual([]);
  });

  it('defaults to -CpuCPU12 without listing', () => {
    const { options: o } = parseOptions('');
    expect(o.cpu).toBe('CPU12');
    expect(o.listing).toBe(false);
  });

  it('warns about unknown options instead of failing', () => {
    const { options, problems } = parseOptions('-CpuHCS12X -Bogus -Xyz=1');
    expect(options.cpu).toBe('HCS12X');
    expect(options.unknown).toEqual(['-Bogus', '-Xyz=1']);
    expect(problems.map((p) => p.code)).toEqual(['A9003', 'A9003']);
  });

  it('tokenizes quotes anywhere in a token', () => {
    expect(tokenizeOptions('-a "b c" -env"X=1 2"d')).toEqual(['-a', 'b c', '-envX=1 2d']);
  });

  it('collects file names', () => {
    expect(parseOptions('main.asm -L').files).toEqual(['main.asm']);
  });
});

describe('special modifiers', () => {
  const env = { TEXTPATH: 'C:\\proj\\bin' };
  const file = 'C:\\Freescale\\my demo\\TheWholeThing.myExt';
  it('expands %(ENV), %n, %p, %N, %E, %e, %f, %", %%', () => {
    expect(expandModifiers('%(TEXTPATH)\\%n.lst', 'Sources\\main.asm', env)).toBe('C:\\proj\\bin\\main.lst');
    expect(expandModifiers('%p', file, env)).toBe('C:\\Freescale\\my demo\\');
    expect(expandModifiers('%N', file, env)).toBe('TheWhole');
    expect(expandModifiers('%n', file, env)).toBe('TheWholeThing');
    expect(expandModifiers('%E', file, env)).toBe('myE');
    expect(expandModifiers('%f%e', file, env)).toBe(file);
    expect(expandModifiers('%"x%"', file, env)).toBe('"x"');
    expect(expandModifiers('100%%', file, env)).toBe('100%');
    expect(expandModifiers('%(NOPE)x', file, env)).toBe('x');
  });
});
