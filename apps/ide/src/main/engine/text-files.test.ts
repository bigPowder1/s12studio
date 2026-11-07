import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OPEN_FILTERS, decodeText, encodeEol, TextFiles } from './text-files';

const dir = mkdtempSync(join(tmpdir(), 's12ide-txt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('TextFiles (editor open/save/save as/revert)', () => {
  const tf = new TextFiles();

  it('keeps a CRLF file CRLF on save without an explicit eol', async () => {
    const p = join(dir, 'main.asm');
    writeFileSync(p, 'a\r\nb\r\n', 'latin1');
    const f = await tf.read(p);
    expect(f).toMatchObject({ text: 'a\nb\n', eol: 'crlf', readOnly: false });
    await tf.write({ path: p, text: 'a\nb\nc\n' });
    expect(readFileSync(p, 'latin1')).toBe('a\r\nb\r\nc\r\n');
  });

  it('keeps an LF file LF; an explicit eol wins and is remembered', async () => {
    const p = join(dir, 'unix.inc');
    writeFileSync(p, 'x\ny\n');
    expect((await tf.read(p)).eol).toBe('lf');
    await tf.write({ path: p, text: 'x\ny\nz\n' });
    expect(readFileSync(p, 'utf8')).toBe('x\ny\nz\n');
    await tf.write({ path: p, text: 'x\n', eol: 'crlf' });
    expect(readFileSync(p, 'utf8')).toBe('x\r\n');
    expect(tf.eolOf(p)).toBe('crlf');
  });

  it('a new file (Save As) defaults to CRLF like CodeWarrior; parent directories are created', async () => {
    const p = join(dir, 'sub', 'new.asm');
    await tf.write({ path: p, text: 'nop\n' });
    expect(readFileSync(p, 'latin1')).toBe('nop\r\n');
  });

  it('expectMtimeMs: refuses to overwrite a file changed on disk since it was read (busy)', async () => {
    const p = join(dir, 'conflict.asm');
    writeFileSync(p, 'one\r\n');
    const f = await tf.read(p);
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    await expect(tf.write({ path: p, text: 'two\n', expectMtimeMs: f.mtimeMs })).rejects.toMatchObject({ code: 'busy' });
    const now = statSync(p).mtimeMs;
    const w = await tf.write({ path: p, text: 'two\n', expectMtimeMs: now });
    expect(w.mtimeMs).toBeGreaterThan(0);
    expect(readFileSync(p, 'latin1')).toBe('two\r\n');
  });

  it('decodes Latin-1 (ANSI) sources and strips a BOM; missing files are not-found', async () => {
    expect(decodeText(new Uint8Array([0x41, 0xb0, 0x0d, 0x0a]))).toEqual({ text: 'A°\n', eol: 'crlf', encoding: 'windows-1252' });
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x0a])).text).toBe('A\n');
    expect(decodeText(new Uint8Array([0x41])).eol).toBe('crlf');
    await expect(tf.read(join(dir, 'nope.asm'))).rejects.toMatchObject({ code: 'not-found' });
    await expect(tf.read(dir)).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it("Save keeps each file's bytes: ANSI stays Windows-1252, UTF-8 stays UTF-8, a BOM is kept", async () => {
    const ansi = join(dir, 'ansi.asm');
    const ansiBytes = Buffer.from([0x20, 0x44, 0x43, 0x2e, 0x42, 0x20, 0x27, 0xb0, 0x80, 0x27, 0x0d, 0x0a]); // DC.B '°€'
    writeFileSync(ansi, ansiBytes);
    const a = await tf.read(ansi);
    expect(a).toMatchObject({ text: " DC.B '°€'\n", encoding: 'windows-1252' });
    await tf.write({ path: ansi, text: a.text });
    expect(readFileSync(ansi)).toEqual(ansiBytes);

    const bom = join(dir, 'bom.asm');
    const bomBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x6e, 0x6f, 0x70, 0x0d, 0x0a]);
    writeFileSync(bom, bomBytes);
    const b = await tf.read(bom);
    expect(b).toMatchObject({ text: 'nop\n', encoding: 'utf-8-bom' });
    await tf.write({ path: bom, text: b.text });
    expect(readFileSync(bom)).toEqual(bomBytes);

    const u8 = join(dir, 'utf8.asm');
    writeFileSync(u8, '; 20 °C → ok\n', 'utf8');
    const u = await tf.read(u8);
    expect(u.encoding).toBe('utf-8');
    await tf.write({ path: u8, text: u.text + '; €\n' });
    expect(readFileSync(u8, 'utf8')).toBe('; 20 °C → ok\n; €\n');

    // every byte value round-trips through an ANSI file (including the 5 undefined Windows-1252 codes)
    const every = join(dir, 'every.bin.asm');
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i).filter((i) => i !== 0x0a && i !== 0x0d)); // not valid UTF-8
    writeFileSync(every, all);
    const e = await tf.read(every);
    expect(e.encoding).toBe('windows-1252');
    await tf.write({ path: every, text: e.text });
    expect(readFileSync(every)).toEqual(all);
  });

  it('ANSI files refuse characters Windows-1252 cannot hold (nothing written); new files are ANSI; encoding override', async () => {
    const p = join(dir, 'plain.asm');
    writeFileSync(p, 'nop\r\n');
    const f = await tf.read(p);
    expect(f.encoding).toBe('windows-1252');
    await expect(tf.write({ path: p, text: 'nop\n; →\n' })).rejects.toMatchObject({ code: 'invalid-argument', message: expect.stringContaining('line 2: character U+2192') });
    expect(readFileSync(p, 'latin1')).toBe('nop\r\n');
    await tf.write({ path: p, text: 'nop\n; °\n' });
    expect([...readFileSync(p)]).toEqual([...Buffer.from('nop\r\n; ', 'latin1'), 0xb0, 0x0d, 0x0a]);
    await tf.write({ path: p, text: 'nop\n; →\n', encoding: 'utf-8' });
    expect(readFileSync(p, 'utf8')).toBe('nop\r\n; →\r\n');
    expect(tf.encodingOf(p)).toBe('utf-8');

    const n = join(dir, 'new-ansi.asm');
    await tf.write({ path: n, text: '; µs\n' });
    expect([...readFileSync(n)]).toEqual([0x3b, 0x20, 0xb5, 0x73, 0x0d, 0x0a]);
  });

  it('encodeEol normalises mixed input', () => {
    expect(encodeEol('a\r\nb\rc\n', 'crlf')).toBe('a\r\nb\r\nc\r\n');
    expect(encodeEol('a\r\nb\n', 'lf')).toBe('a\nb\n');
  });

  it('File > Open filters list the CodeWarrior file kinds', () => {
    const all = DEFAULT_OPEN_FILTERS[0].extensions;
    for (const e of ['mcp', 'asm', 'inc', 'prm', 'abs']) expect(all).toContain(e);
    expect(DEFAULT_OPEN_FILTERS.at(-1)?.extensions).toEqual(['*']);
  });
});
