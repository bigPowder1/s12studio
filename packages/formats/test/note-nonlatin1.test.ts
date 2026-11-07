/**
 * Strings CodeWarrior records as 8-bit text (.note command line and user, DWARF names, string tables, the S0 header):
 * characters above U+00FF become '?' instead of throwing; Latin-1 text keeps its exact bytes.
 */
import { describe, expect, it } from 'vitest';
import {
  ByteWriter,
  HiwareNoteType,
  buildCwStringTable,
  buildHiwareNotes,
  hiwareNote,
  latin1BestFit,
  latin1BestFitBytes,
  latin1ToBytes,
  noteDescString,
  parseHiwareNotes,
  readSRecords,
  stringDesc,
  writeSRecords,
} from '@s12/formats';

const PATH = 'C:\\Users\\student\\Lab 4 – 학생\\bin\\Project.abs';

describe('best-fit 8-bit strings', () => {
  it("maps characters above U+00FF to '?', one per character (surrogate pairs too)", () => {
    expect(latin1BestFit('Lab 4 – 학생')).toBe('Lab 4 ? ??');
    expect(latin1BestFit('Nguyễn')).toBe('Nguy?n');
    expect(latin1BestFit('a\u{20000}b')).toBe('a?b');
    expect(latin1BestFit('lone \ud800 surrogate')).toBe('lone ? surrogate');
  });

  it('keeps Latin-1 text unchanged (same string, same bytes)', () => {
    const s = 'Grüße é\x96\xff C:\\Temp';
    expect(latin1BestFit(s)).toBe(s);
    expect(latin1BestFitBytes(s)).toEqual(latin1ToBytes(s));
  });

  it('latin1ToBytes stays strict (callers that must not lose characters still get an error)', () => {
    expect(() => latin1ToBytes('–')).toThrow(RangeError);
  });

  it('ByteWriter.cstr and stringDesc never throw', () => {
    expect([...new ByteWriter().cstr('é–x').finish()]).toEqual([0xe9, 0x3f, 0x78, 0]);
    const notes = buildHiwareNotes([hiwareNote(HiwareNoteType.CommandLine, stringDesc(`-objn"${PATH}"`)), hiwareNote(HiwareNoteType.User, stringDesc('Nguyễn'))]);
    const back = parseHiwareNotes(notes).notes;
    expect(noteDescString(back[0].desc)).toBe('-objn"C:\\Users\\student\\Lab 4 ? ??\\bin\\Project.abs"');
    expect(noteDescString(back[1].desc)).toBe('Nguy?n');
  });

  it('ELF string tables never throw', () => {
    const { data } = buildCwStringTable(['main', 'x–y']);
    expect([...data]).toEqual([0, ...latin1ToBytes('main'), 0, ...latin1ToBytes('x?y'), 0]);
  });

  it("S0 header: '?' for characters above U+00FF, Latin-1 bytes kept", () => {
    const text = writeSRecords([{ address: 0x4000, data: Uint8Array.of(1, 2) }], { header: PATH });
    expect(readSRecords(text).header).toBe('C:\\Users\\student\\Lab 4 ? ??\\bin\\Project.abs');
    const latin = writeSRecords([{ address: 0x4000, data: Uint8Array.of(1) }], { header: 'C:\\é' });
    expect(latin.split('\r\n')[0]).toBe('S0070000433A5CE936');
  });
});
