/**
 * Text files for the editor (File > Open / Save / Save As / Revert): decode, remember each file's line-ending style
 * and byte encoding (ANSI / UTF-8 / UTF-8+BOM) and write it back the same way (CodeWarrior sources are CRLF; an LF file stays LF), mtime conflict check, and the
 * File > Open dialog filters.
 */
import { access, constants, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApiError } from '../../shared/api/common';
import type { Eol, FileFilter, TextEncodingName, TextFile, WriteTextRequest } from '../../shared/api/files';
import { normKey } from './path-key';

/**
 * File > Open filters (CodeWarrior's "All Files" list for an HC12 project). The first filter is the default.
 * UNCERTAIN: CodeWarrior 5.1's exact filter names; the extension set follows ide.md (§2 File menu) + project kinds.
 */
export const DEFAULT_OPEN_FILTERS: FileFilter[] = [
  { name: 'All Supported Files', extensions: ['mcp', 'asm', 'inc', 's', 'prm', 'abs', 's19', 'map', 'lst', 'dbg', 'ini', 'cmd', 'hwl', 'bbl', 'txt', 'xpr', 'bpt', 'c', 'h'] },
  { name: 'Project Files (*.mcp)', extensions: ['mcp'] },
  { name: 'Assembler Files (*.asm, *.inc, *.s)', extensions: ['asm', 'inc', 's'] },
  { name: 'Linker Files (*.prm)', extensions: ['prm'] },
  { name: 'Absolute Files (*.abs)', extensions: ['abs'] },
  { name: 'Text Files (*.txt, *.lst, *.map, *.ini, *.cmd)', extensions: ['txt', 'lst', 'map', 'ini', 'cmd', 'hwl'] },
  { name: 'All Files (*.*)', extensions: ['*'] },
];

/**
 * Decode a text file. A UTF-8 BOM -> 'utf-8-bom'; valid UTF-8 with non-ASCII characters -> 'utf-8'; everything else
 * (pure ASCII, or ANSI bytes that are not valid UTF-8) -> 'windows-1252', CodeWarrior 5.1's ANSI code page.
 * UNCERTAIN: CodeWarrior's editor is ANSI-only; UTF-8 detection exists so files written by other editors round-trip.
 */
export function decodeText(bytes: Uint8Array): { text: string; eol: Eol; encoding: TextEncodingName } {
  let raw: string;
  let encoding: TextEncodingName;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8-bom';
    raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3));
  } else if (bytes.every((b) => b < 0x80)) {
    encoding = 'windows-1252';
    raw = new TextDecoder('windows-1252').decode(bytes);
  } else {
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      encoding = 'utf-8';
    } catch {
      raw = new TextDecoder('windows-1252').decode(bytes);
      encoding = 'windows-1252';
    }
  }
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/(?<!\r)\n/g) ?? []).length;
  return { text: raw.replace(/\r\n?/g, '\n'), eol: crlf >= lf && crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'crlf', encoding };
}

/** '\n' text -> file text with the given line ending. */
export function encodeEol(text: string, eol: Eol): string {
  const n = text.replace(/\r\n?/g, '\n');
  return eol === 'crlf' ? n.replace(/\n/g, '\r\n') : n;
}

/** Unicode -> Windows-1252 byte (the WHATWG decoder's table reversed, so decode/encode round-trips every byte). */
let cp1252: Map<number, number> | null = null;
function cp1252Table(): Map<number, number> {
  if (cp1252) return cp1252;
  const all = new Uint8Array(256).map((_, i) => i);
  const chars = new TextDecoder('windows-1252').decode(all);
  cp1252 = new Map([...chars].map((c, i) => [c.codePointAt(0)!, i]));
  return cp1252;
}

/** Encode file text; throws ApiError('invalid-argument') for a character the encoding cannot hold. */
export function encodeText(text: string, encoding: TextEncodingName): Uint8Array {
  if (encoding !== 'windows-1252') {
    const body = new TextEncoder().encode(text);
    if (encoding === 'utf-8') return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  const table = cp1252Table();
  const out = new Uint8Array(text.length);
  let n = 0;
  let line = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const b = table.get(cp);
    if (b === undefined) {
      throw new ApiError(
        'invalid-argument',
        `line ${line}: character U+${cp.toString(16).toUpperCase().padStart(4, '0')} "${ch}" cannot be saved in the file's ANSI (Windows-1252) encoding`,
      );
    }
    if (cp === 10) line++;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

const key = (path: string): string => normKey(path);

export class TextFiles {
  /** Line ending of every file read (or written) this session, by path. */
  private eols = new Map<string, Eol>();
  /** Encoding of every file read (or written) this session, by path. */
  private encodings = new Map<string, TextEncodingName>();

  /** Remembered encoding of `path` (undefined: never read). */
  encodingOf(path: string): TextEncodingName | undefined {
    return this.encodings.get(key(path));
  }

  /** Remembered line ending of `path` (undefined: never read). */
  eolOf(path: string): Eol | undefined {
    return this.eols.get(key(path));
  }

  async read(path: string): Promise<TextFile> {
    try {
      const [bytes, st] = await Promise.all([readFile(path), stat(path)]);
      if (st.isDirectory()) throw new ApiError('invalid-argument', `${path} is a directory`);
      const readOnly = await access(path, constants.W_OK).then(
        () => false,
        () => true,
      );
      const d = decodeText(bytes);
      this.eols.set(key(path), d.eol);
      this.encodings.set(key(path), d.encoding);
      return { path, ...d, mtimeMs: st.mtimeMs, readOnly };
    } catch (e) {
      return io(e, path);
    }
  }

  /**
   * Write `req.text`. Line ending: `req.eol`, else the style the file had when read (Save keeps a file's style;
   * Save As to a new path keeps the source's style when the editor passes it), else CRLF.
   */
  async write(req: WriteTextRequest): Promise<{ mtimeMs: number }> {
    if (req.expectMtimeMs !== undefined) {
      const st = await stat(req.path).catch(() => null);
      if (st && Math.abs(st.mtimeMs - req.expectMtimeMs) > 1) throw new ApiError('busy', `${req.path} was changed on disk`);
    }
    const eol = req.eol ?? this.eolOf(req.path) ?? 'crlf';
    // UNCERTAIN: new files are ANSI (Windows-1252) like CodeWarrior 5.1's editor.
    const encoding = req.encoding ?? this.encodingOf(req.path) ?? 'windows-1252';
    const bytes = encodeText(encodeEol(req.text, eol), encoding); // before touching the file: unencodable text fails cleanly
    try {
      await mkdir(dirname(req.path), { recursive: true });
      // in place (keeps permissions, links and read-only protection of the existing file)
      await writeFile(req.path, bytes);
      this.eols.set(key(req.path), eol);
      this.encodings.set(key(req.path), encoding);
      return { mtimeMs: (await stat(req.path)).mtimeMs };
    } catch (e) {
      return io(e, req.path);
    }
  }
}

function io(e: unknown, path: string): never {
  if (e instanceof ApiError) throw e;
  const code = (e as NodeJS.ErrnoException).code;
  throw new ApiError(code === 'ENOENT' ? 'not-found' : code === 'EISDIR' ? 'invalid-argument' : 'io', `${path}: ${(e as Error).message}`);
}
