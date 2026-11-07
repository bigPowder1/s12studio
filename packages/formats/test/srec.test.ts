import { describe, it, expect } from 'vitest';
import { readFixture, itFx } from './fixtures';
import { readSRecords, writeSRecords, formatSRecord, mergeSRecordBlocks, chooseSRecordType, recordTypeFor, SRecordParseError, SRECORD_MAX_HEADER_BYTES } from '../src/srec';

/** The S0 header text decoded by hand from the first line (the .abs path on the lab PC that built the golden file). */
const s0Text = (file: string): string => {
  const line = file.split(/\r?\n/)[0];
  const n = parseInt(line.slice(2, 4), 16) - 3;
  return Buffer.from(line.slice(8, 8 + 2 * n), 'hex').toString('latin1');
};

describe('S-record reader', () => {
  itFx('reads Lab3 Project.abs.s19', () => {
    const f = readSRecords(new Uint8Array(readFixture('Lab3', 'bin', 'Project.abs.s19')));
    const LAB3_ABS = s0Text(readFixture('Lab3', 'bin', 'Project.abs.s19').toString('latin1'));
    expect(LAB3_ABS).toMatch(/\\bin\\Project\.abs$/);
    expect(f.errors).toEqual([]);
    expect(f.eol).toBe('\r\n');
    expect(f.header).toBe(LAB3_ABS);
    expect(f.headerAddress).toBe(0);
    expect(f.terminator).toEqual({ type: 9, address: 0 });
    expect(f.records.every((r) => r.checksumOk)).toBe(true);
    expect(f.records.filter((r) => r.type === 1)).toHaveLength(65);
    expect(f.blocks.map((b) => b.address)).toEqual([0x4000, 0xc000, 0xffce, 0xfffe]);
    expect([...f.blocks[2].data]).toEqual([0x08, 0x45]);
    expect([...f.blocks[3].data]).toEqual([0xc0, 0x00]);
    expect(f.blocks[1].data.length).toBe(0xe3);
  });

  itFx('reads Lab3 Project.abs.glo (S2 records, S9 terminator)', () => {
    const f = readSRecords(readFixture('Lab3', 'bin', 'Project.abs.glo').toString('latin1'));
    expect(f.errors).toEqual([]);
    expect(new Set(f.records.slice(1, -1).map((r) => r.type))).toEqual(new Set([2]));
    expect(f.terminator).toEqual({ type: 9, address: 0 });
    expect(f.blocks.map((b) => b.address)).toEqual([0x7f4000, 0x7fc000, 0x7fffce, 0x7ffffe]);
  });

  it('detects checksum errors and malformed lines', () => {
    const f = readSRecords('S105FFFEC0003E\r\nS1zz\r\nS10500\r\nX\r\nS9030000FC\r\n');
    expect(f.errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(f.errors[0].message).toMatch(/checksum mismatch \(expected 3D\)/);
    expect(f.records[0].checksumOk).toBe(false);
    expect(() => readSRecords('S105FFFEC0003E', { strict: true })).toThrow(SRecordParseError);
  });

  it('handles S3/S5/S7/S8 and LF input', () => {
    const text = [formatSRecord(3, 0x12345678, new Uint8Array([1, 2])), formatSRecord(5, 1), formatSRecord(7, 0x12345678)].join('\n') + '\n';
    const f = readSRecords(text);
    expect(f.errors).toEqual([]);
    expect(f.eol).toBe('\n');
    expect(f.blocks).toEqual([{ address: 0x12345678, data: new Uint8Array([1, 2]) }]);
    expect(f.recordCount).toBe(1);
    expect(f.terminator).toEqual({ type: 7, address: 0x12345678 });
    expect(readSRecords(formatSRecord(8, 0x123456)).terminator).toEqual({ type: 8, address: 0x123456 });
    const bad = readSRecords(text.replace(formatSRecord(5, 1), formatSRecord(5, 2)));
    expect(bad.errors[0].message).toMatch(/count/);
  });
});

describe('S-record writer (CodeWarrior Burner style)', () => {
  for (const proj of ['Lab3', 'blank_project']) {
    for (const ext of ['s19', 'glo']) {
      itFx(`${proj}: re-writes Project.abs.${ext} byte-identically`, () => {
        const golden = readFixture(proj, 'bin', `Project.abs.${ext}`).toString('latin1');
        const f = readSRecords(golden);
        expect(f.errors).toEqual([]);
        const out = writeSRecords(f.blocks, { header: f.header });
        expect(out).toBe(golden);
      });
    }
  }

  it('auto record type: S1 for 16-bit, S2 for 24-bit, S3 above', () => {
    expect(chooseSRecordType([{ address: 0xfffe, data: new Uint8Array(2) }])).toBe('S1');
    expect(chooseSRecordType([{ address: 0xffff, data: new Uint8Array(2) }])).toBe('S2');
    expect(chooseSRecordType([{ address: 0x7ffffe, data: new Uint8Array(2) }])).toBe('S2');
    expect(chooseSRecordType([{ address: 0x1000000, data: new Uint8Array(1) }])).toBe('S3');
  });

  it('formats records and terminators', () => {
    expect(formatSRecord(9, 0)).toBe('S9030000FC');
    expect(formatSRecord(1, 0xfffe, new Uint8Array([0xc0, 0x00]))).toBe('S105FFFEC0003D');
    expect(formatSRecord(2, 0x7ffffe, new Uint8Array([0xc0, 0x00]))).toBe('S2067FFFFEC000BD');
    expect(() => formatSRecord(1, 0x10000)).toThrow(RangeError);
    const blocks = [{ address: 0x10, data: new Uint8Array(40).fill(0xaa) }];
    const out = writeSRecords(blocks, { recordType: 'S2', bytesPerRecord: 16, eol: '\n', terminator: 'matching', entry: 0x10 });
    const lines = out.trimEnd().split('\n');
    expect(lines.map((l) => l.slice(0, 4))).toEqual(['S214', 'S214', 'S20C', 'S804']);
    expect(lines[3]).toBe(formatSRecord(8, 0x10));
    expect(writeSRecords(blocks, { terminator: 'none', countRecord: true }).trimEnd().split('\r\n').pop()).toBe(formatSRecord(5, 2));
  });

  it('merges adjacent and overlapping blocks', () => {
    const m = mergeSRecordBlocks([
      { address: 4, data: new Uint8Array([4, 5]) },
      { address: 0, data: new Uint8Array([0, 1, 2, 3]) },
      { address: 5, data: new Uint8Array([9, 6]) },
      { address: 10, data: new Uint8Array([10]) },
    ]);
    expect(m).toEqual([
      { address: 0, data: new Uint8Array([0, 1, 2, 3, 4, 9, 6]) },
      { address: 10, data: new Uint8Array([10]) },
    ]);
  });
});

describe('S-record writer: review regressions', () => {
  const blocks = [{ address: 0x4000, data: new Uint8Array([1, 2, 3]) }];

  it('an over-long S0 path is truncated to 252 bytes instead of throwing (finding 5)', () => {
    const header = 'C:\\' + 'a'.repeat(300);
    const text = writeSRecords(blocks, { header });
    const f = readSRecords(text);
    expect(f.errors).toEqual([]);
    expect(SRECORD_MAX_HEADER_BYTES).toBe(252);
    expect(f.header).toBe(header.slice(0, 252));
    expect(text.split('\r\n')[0].slice(2, 4)).toBe('FF');
    // exactly 252 is kept whole
    expect(readSRecords(writeSRecords(blocks, { header: 'b'.repeat(252) })).header).toBe('b'.repeat(252));
  });

  it("accepts the Burner's 'Sx' as a synonym for 'auto' (finding 10)", () => {
    expect(writeSRecords(blocks, { recordType: 'Sx' })).toBe(writeSRecords(blocks, { recordType: 'auto' }));
  });

  it('recordTypePolicy per-record picks S1/S2 per record; per-file (default) uses one type (finding 11)', () => {
    const mixed = [
      { address: 0xc000, data: new Uint8Array([0xaa]) },
      { address: 0xe08000, data: new Uint8Array([0xbb]) },
    ];
    const perFile = readSRecords(writeSRecords(mixed));
    expect(perFile.records.filter((r) => r.type >= 1 && r.type <= 3).map((r) => r.type)).toEqual([2, 2]);
    const perRec = readSRecords(writeSRecords(mixed, { recordTypePolicy: 'per-record' }));
    expect(perRec.errors).toEqual([]);
    expect(perRec.records.filter((r) => r.type >= 1 && r.type <= 3).map((r) => r.type)).toEqual([1, 2]);
    expect(perRec.blocks).toEqual(perFile.blocks);
    // a record straddling 0xFFFF/0x10000 needs S2
    expect(recordTypeFor(0xfff0, 0x20)).toBe('S2');
    expect(recordTypeFor(0xffe0, 0x20)).toBe('S1');
    // explicit type ignores the policy
    expect(readSRecords(writeSRecords(mixed, { recordType: 'S3', recordTypePolicy: 'per-record' })).records[0].type).toBe(3);
  });

  for (const proj of ['Lab3', 'blank_project']) {
    itFx(`${proj}: per-record policy still reproduces the single-width goldens`, () => {
      for (const ext of ['s19', 'glo']) {
        const text = readFixture(proj, 'bin', `Project.abs.${ext}`).toString('latin1');
        const f = readSRecords(text);
        expect(writeSRecords(f.blocks, { header: f.header, recordTypePolicy: 'per-record' })).toBe(text);
      }
    });
  }
});
