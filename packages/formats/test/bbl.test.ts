import { describe, it, expect } from 'vitest';
import { readFixture, describeFx, itFx } from './fixtures';
import { parseBbl, planBbl, applyBblTransfers, bblOutputWriteOptions, expandBblMacros, parseBblNumber } from '../src/text/bbl';
import { readSRecords, writeSRecords } from '../src/srec';

/** Any tool path works here: the planner only threads it through to the outputs. */
const ABS = 'C:\\Users\\student\\ME3305\\Lab3\\bin\\Project.abs';

describeFx('Burner .bbl: fixtures/Lab3/prm/burner.bbl', () => {
  const text = readFixture('Lab3', 'prm', 'burner.bbl').toString('latin1');
  const bbl = parseBbl(text);

  it('parses without errors into an ordered command list', () => {
    expect(bbl.errors).toEqual([]);
    expect(bbl.commands[0]).toEqual({ kind: 'openfile', file: '%ABS_FILE%.glo', line: 2, col: 1 });
    expect(bbl.commands[1]).toMatchObject({ kind: 'set', name: 'format', key: 'format', value: 'motorola' });
    expect(bbl.commands[2]).toMatchObject({ kind: 'set', key: 'buswidth', value: 1 });
    expect(bbl.commands[3]).toMatchObject({ kind: 'set', name: 'SRECORD', key: 'srecord', value: 'Sx' });
    expect(bbl.commands[4]).toMatchObject({ kind: 'set', key: 'len', value: 0x1800000, line: 8 });
    const kinds = bbl.commands.map((c) => c.kind);
    expect(kinds.filter((k) => k === 'openfile')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'close')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'send')).toHaveLength(4 + 64 + 4 + 64);
    expect(bbl.commands.find((c) => c.kind === 'send')).toMatchObject({ width: 'byte', lane: 1, file: '%ABS_FILE%' });
  });

  it('plans two outputs with the expected address windows', () => {
    const plan = planBbl(bbl, { env: { ABS_FILE: ABS } });
    expect(plan.warnings).toEqual([]);
    expect(plan.outputs.map((o) => o.file)).toEqual([`${ABS}.glo`, `${ABS}.s19`]);
    const [glo, s19] = plan.outputs;
    for (const o of plan.outputs) expect(o).toMatchObject({ format: 'srecord', srecord: 'Sx', sLineLen: 32, undefByte: 0xff, swapByte: false, isCom: false });
    expect(glo.transfers).toHaveLength(68);
    const w = (t: { origin: number; len: number; destination: number }) => [t.origin, t.len, t.destination];
    expect(w(glo.transfers[0])).toEqual([0x1000000, 0x1800000, 0]);
    expect(w(glo.transfers[1])).toEqual([0x008000, 0x4000, 0x7f8000]);
    expect(w(glo.transfers[2])).toEqual([0x004000, 0x4000, 0x7f4000]);
    expect(w(glo.transfers[3])).toEqual([0x00c000, 0x4000, 0x7fc000]);
    expect(w(glo.transfers[4])).toEqual([0xc08000, 0x4000, 0x700000]);
    expect(w(glo.transfers[67])).toEqual([0xff8000, 0x4000, 0x7fc000]);
    expect(glo.transfers.every((t) => t.input === ABS && t.busWidth === 1)).toBe(true);
    expect(s19.transfers).toHaveLength(68);
    expect(w(s19.transfers[0])).toEqual([0x4000, 0x4000, 0x4000]);
    expect(w(s19.transfers[1])).toEqual([0xc000, 0x4000, 0xc000]);
    expect(w(s19.transfers[2])).toEqual([0x8000, 0x4000, 0xfe8000]);
    expect(w(s19.transfers[3])).toEqual([0xc00000, 0x400000, 0xc00000]);
    expect(w(s19.transfers[4])).toEqual([0x1700000, 0x4000, 0xc08000]);
    expect(w(s19.transfers[67])).toEqual([0x17fc000, 0x4000, 0xff8000]);
  });

  for (const proj of ['Lab3', 'blank_project']) {
    itFx(`${proj}: executing the plan on the logical image reproduces the golden .s19 and .glo`, () => {
      const s19Text = readFixture(proj, 'bin', 'Project.abs.s19').toString('latin1');
      const gloText = readFixture(proj, 'bin', 'Project.abs.glo').toString('latin1');
      const s19 = readSRecords(s19Text);
      // the .s19 is the identity image of the .abs code windows, so use it as the "input file"
      const plan = planBbl(parseBbl(readFixture(proj, 'prm', 'burner.bbl').toString('latin1')), { env: { ABS_FILE: s19.header! } });
      const [glo, s19out] = plan.outputs;
      const warn: string[] = [];
      expect(writeSRecords(applyBblTransfers(s19.blocks, glo.transfers, warn), { header: s19.header })).toBe(gloText);
      expect(writeSRecords(applyBblTransfers(s19.blocks, s19out.transfers, warn), { header: s19.header })).toBe(s19Text);
      expect(warn).toEqual([]);
    });
  }
});

describe('Burner .bbl syntax coverage', () => {
  it('numbers and macros', () => {
    expect(parseBblNumber('0x10')).toBe(16);
    expect(parseBblNumber('$10')).toBe(16);
    expect(parseBblNumber('10')).toBe(10);
    expect(parseBblNumber('0Fh')).toBe(15);
    expect(parseBblNumber('Sx')).toBeUndefined();
    const w: string[] = [];
    expect(expandBblMacros('%A%.%B%', { A: 'x' }, w)).toBe('x.%B%');
    expect(w).toEqual(['undefined macro %B%']);
  });

  it('wizard-style file with := , (* *) comments, FOR loop, IF, ECHO and OPENCOM', () => {
    const src = `(* header *)
OPENFILE "out#.phy"
format := motorola
SRECORD = S2
busWidth = 1
len = 0x4000
FOR i = 0x30 TO 0x31 DO
  origin = i
  destination = 0x80000
  SENDBYTE 1 "%ABS_FILE%"
END
IF 1 = 2 THEN ECHO "three" ELSE ECHO "other" END
CLOSE
OPENCOM 1
SENDWORD 2 "x.abs"
CLOSE
`;
    const f = parseBbl(src);
    expect(f.errors).toEqual([]);
    expect(f.commands.map((c) => c.kind)).toEqual(['openfile', 'set', 'set', 'set', 'set', 'for', 'if', 'close', 'opencom', 'send', 'close']);
    const loop = f.commands[5];
    expect(loop).toMatchObject({ kind: 'for', variable: 'i', from: 0x30, to: 0x31 });
    const plan = planBbl(f, { env: { ABS_FILE: 'a.abs' } });
    expect(plan.outputs.map((o) => o.file)).toEqual(['out#.phy', 'COM1']);
    expect(plan.outputs[0].srecord).toBe('S2');
    expect(plan.outputs[0].transfers.map((t) => t.origin)).toEqual([0x30, 0x31]);
    expect(plan.outputs[1]).toMatchObject({ isCom: true });
    expect(plan.outputs[1].transfers[0]).toMatchObject({ width: 'word', lane: 2, input: 'x.abs' });
    expect(plan.messages).toEqual(['other']);
    expect(plan.warnings).toEqual([]);
  });

  it('reports errors with line numbers', () => {
    const f = parseBbl('OPENFILE\nSENDBYTE x "f"\nfoo\nFOR j = 1 TO 2 DO\nCLOSE\nEND\n/* open');
    expect(f.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 7]);
  });

  it('planner warns about unbalanced OPENFILE/CLOSE and SEND without output', () => {
    const plan = planBbl(parseBbl('SENDBYTE 1 "a"\nCLOSE\nOPENFILE "x"\n'));
    expect(plan.warnings).toHaveLength(3);
  });
});

describe('Burner .bbl: review regressions', () => {
  it('busWidth defaults to 1 when the file never sets it (finding 1)', () => {
    const src = 'OPENFILE "a.s19"\nformat=motorola\nSRECORD=S2\norigin=0\nlen=0x100\nSENDBYTE 1 "%ABS_FILE%"\nCLOSE\n';
    const plan = planBbl(parseBbl(src), { env: { ABS_FILE: 'x.abs' } });
    expect(plan.warnings).toEqual([]);
    expect(plan.outputs[0].transfers[0].busWidth).toBe(1);
    const warn: string[] = [];
    const out = applyBblTransfers([{ address: 0x10, data: new Uint8Array([1, 2, 3]) }], plan.outputs[0].transfers, warn);
    expect(warn).toEqual([]);
    expect(out).toEqual([{ address: 0x10, data: new Uint8Array([1, 2, 3]) }]);
  });

  it('defaults (no format/SRECORD/SLINELEN/undefByte set) come from the lower-cased default table', () => {
    const plan = planBbl(parseBbl('OPENFILE "a.s19"\nSENDBYTE 1 "a.abs"\nCLOSE\n'));
    expect(plan.warnings).toEqual([]);
    expect(plan.outputs[0]).toMatchObject({ format: 'srecord', srecord: 'Sx', sLineLen: 32, undefByte: 0xff });
    expect(plan.outputs[0].transfers[0]).toMatchObject({ origin: 0, len: 0x10000, destination: 0, busWidth: 1 });
  });

  it('bblOutputWriteOptions maps SRECORD/SLINELEN to writer options (finding 10)', () => {
    const plan = planBbl(parseBbl('OPENFILE "a"\nSRECORD=S2\nSLINELEN=16\nCLOSE\nOPENFILE "b"\nSRECORD=Sx\nCLOSE\n'));
    expect(bblOutputWriteOptions(plan.outputs[0], 'p.abs')).toEqual({ header: 'p.abs', recordType: 'S2', bytesPerRecord: 16 });
    // parameters persist across OPENFILEs, so SLINELEN=16 carries over to the second output
    expect(bblOutputWriteOptions(plan.outputs[1])).toEqual({ header: undefined, recordType: 'auto', bytesPerRecord: 16 });
  });

  for (const proj of ['Lab3', 'blank_project']) {
    itFx(`${proj}: golden replay through bblOutputWriteOptions`, () => {
      const s19Text = readFixture(proj, 'bin', 'Project.abs.s19').toString('latin1');
      const gloText = readFixture(proj, 'bin', 'Project.abs.glo').toString('latin1');
      const s19 = readSRecords(s19Text);
      const plan = planBbl(parseBbl(readFixture(proj, 'prm', 'burner.bbl').toString('latin1')), { env: { ABS_FILE: s19.header! } });
      const [glo, s19out] = plan.outputs;
      expect(writeSRecords(applyBblTransfers(s19.blocks, glo.transfers), bblOutputWriteOptions(glo, s19.header))).toBe(gloText);
      expect(writeSRecords(applyBblTransfers(s19.blocks, s19out.transfers), bblOutputWriteOptions(s19out, s19.header))).toBe(s19Text);
    });
  }
});
