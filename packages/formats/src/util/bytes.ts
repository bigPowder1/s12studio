// Big-endian byte reader/writer used by the ELF, LIB and DWARF codecs.
// Engine code: Uint8Array + DataView only (no Node Buffer).

const latin1 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/** Decode bytes as Latin-1 (CodeWarrior strings are Windows-1252/ASCII; Latin-1 is a lossless byte mapping). */
export const bytesToLatin1 = latin1;

/** Encode a string as Latin-1 bytes (chars > 0xFF are an error). */
export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new RangeError(`non-Latin-1 character U+${c.toString(16)} in ${JSON.stringify(s)}`);
    out[i] = c;
  }
  return out;
}

/**
 * Best-fit 8-bit form of a string for CodeWarrior's tools: each character above U+00FF (a surrogate pair counts as one
 * character) becomes '?'; Latin-1 text is returned unchanged. Paths and user names recorded by a build (.note, DWARF,
 * listing, map, S0) go through this, so a folder named "Lab 4 – 학생" builds instead of failing.
 * UNCERTAIN: a Windows-1252 PC would store the few characters in its 0x80-0x9F block (en dash, curly quotes, euro)
 * as those bytes; we use '?' for every character above U+00FF (paths are exempt from the byte-identical rule).
 */
export function latin1BestFit(s: string): string {
  return /[^\x00-\xff]/.test(s) ? s.replace(/[\ud800-\udbff][\udc00-\udfff]|[^\x00-\xff]/g, '?') : s;
}

/** Encode a string as Latin-1 bytes, characters above U+00FF as '?' (see latin1BestFit). Never throws. */
export function latin1BestFitBytes(s: string): Uint8Array {
  return latin1ToBytes(latin1BestFit(s));
}

/** Read a NUL-terminated Latin-1 string at `off` (throws if unterminated). */
export function readCString(bytes: Uint8Array, off: number): string {
  let end = off;
  while (end < bytes.length && bytes[end] !== 0) end++;
  if (end >= bytes.length) throw new RangeError(`unterminated string at 0x${off.toString(16)}`);
  return latin1(bytes.subarray(off, end));
}

export const alignUp = (n: number, a: number): number => (a <= 1 ? n : Math.ceil(n / a) * a);

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Big-endian cursor over a byte array. */
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.bytes.length;
  }
  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }
  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  private need(n: number): number {
    const p = this.pos;
    if (p + n > this.bytes.length) throw new RangeError(`read of ${n} bytes at 0x${p.toString(16)} past end (0x${this.bytes.length.toString(16)})`);
    this.pos = p + n;
    return p;
  }

  seek(pos: number): this {
    this.pos = pos;
    return this;
  }
  skip(n: number): this {
    this.need(n);
    return this;
  }
  align(a: number): this {
    this.pos = alignUp(this.pos, a);
    return this;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  i8(): number {
    return this.view.getInt8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), false);
  }
  i16(): number {
    return this.view.getInt16(this.need(2), false);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), false);
  }
  i32(): number {
    return this.view.getInt32(this.need(4), false);
  }
  /** Unsigned big-endian integer of `n` bytes (n <= 4). */
  uN(n: number): number {
    let v = 0;
    const p = this.need(n);
    for (let i = 0; i < n; i++) v = v * 256 + this.bytes[p + i];
    return v;
  }
  bytesN(n: number): Uint8Array {
    const p = this.need(n);
    return this.bytes.subarray(p, p + n);
  }
  /** NUL-terminated Latin-1 string; consumes the NUL. */
  cstr(): string {
    const s = readCString(this.bytes, this.pos);
    this.pos += s.length + 1;
    return s;
  }
  uleb128(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      mul *= 128;
      if ((b & 0x80) === 0) return result;
    }
  }
  sleb128(): number {
    let result = 0;
    let mul = 1;
    let b: number;
    do {
      b = this.u8();
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    if (b & 0x40) result -= mul;
    return result;
  }
}

/** Growable big-endian byte writer. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initial = 256) {
    this.buf = new Uint8Array(Math.max(16, initial));
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.len;
  }

  private ensure(n: number): number {
    const p = this.len;
    if (p + n > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < p + n) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
      this.view = new DataView(nb.buffer);
    }
    this.len = p + n;
    return p;
  }

  // NOTE: ensure() may reallocate buf/view, so it is always called before touching them.
  u8(v: number): this {
    const p = this.ensure(1);
    this.view.setUint8(p, v & 0xff);
    return this;
  }
  i8(v: number): this {
    const p = this.ensure(1);
    this.view.setInt8(p, v);
    return this;
  }
  u16(v: number): this {
    const p = this.ensure(2);
    this.view.setUint16(p, v & 0xffff, false);
    return this;
  }
  i16(v: number): this {
    const p = this.ensure(2);
    this.view.setInt16(p, v, false);
    return this;
  }
  u32(v: number): this {
    const p = this.ensure(4);
    this.view.setUint32(p, v >>> 0, false);
    return this;
  }
  i32(v: number): this {
    const p = this.ensure(4);
    this.view.setInt32(p, v, false);
    return this;
  }
  /** Unsigned big-endian integer of `n` bytes (n <= 4). */
  uN(v: number, n: number): this {
    const p = this.ensure(n);
    for (let i = n - 1; i >= 0; i--) {
      this.buf[p + i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    return this;
  }
  bytes(b: Uint8Array): this {
    const p = this.ensure(b.length); // may reallocate this.buf
    this.buf.set(b, p);
    return this;
  }
  zeros(n: number): this {
    const p = this.ensure(n);
    this.buf.fill(0, p, this.len);
    return this;
  }
  /** Latin-1 string followed by NUL (characters above U+00FF are written as '?', see latin1BestFit). */
  cstr(s: string): this {
    this.bytes(latin1BestFitBytes(s));
    return this.u8(0);
  }
  uleb128(v: number): this {
    if (v < 0) throw new RangeError('uleb128 of negative value');
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v !== 0) b |= 0x80;
      this.u8(b);
    } while (v !== 0);
    return this;
  }
  sleb128(v: number): this {
    for (;;) {
      const b = ((v % 128) + 128) % 128;
      v = Math.floor(v / 128);
      const done = (v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0);
      this.u8(done ? b : b | 0x80);
      if (done) return this;
    }
  }
  /** Pad with zeros to a multiple of `a`. */
  align(a: number): this {
    return this.zeros(alignUp(this.len, a) - this.len);
  }
  /** Patch a big-endian u32 at an earlier position. */
  setU32(pos: number, v: number): this {
    this.view.setUint32(pos, v >>> 0, false);
    return this;
  }
  setU16(pos: number, v: number): this {
    this.view.setUint16(pos, v & 0xffff, false);
    return this;
  }
  setU8(pos: number, v: number): this {
    this.view.setUint8(pos, v & 0xff);
    return this;
  }
  /** A copy of the written bytes. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Read an unsigned big-endian field of `n` bytes at `off`. */
export function readBE(bytes: Uint8Array, off: number, n: number): number {
  if (off < 0 || off + n > bytes.length) throw new RangeError(`field of ${n} bytes at 0x${off.toString(16)} out of range`);
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + bytes[off + i];
  return v;
}

/** Write an unsigned big-endian field of `n` bytes at `off` (value truncated to the field). */
export function writeBE(bytes: Uint8Array, off: number, n: number, v: number): void {
  if (off < 0 || off + n > bytes.length) throw new RangeError(`field of ${n} bytes at 0x${off.toString(16)} out of range`);
  for (let i = n - 1; i >= 0; i--) {
    bytes[off + i] = v & 0xff;
    v = Math.floor(v / 256);
  }
}

/** Sign-extend the low `bits` of `v`. */
export function signExtend(v: number, bits: number): number {
  const m = 2 ** bits;
  v = ((v % m) + m) % m;
  return v >= m / 2 ? v - m : v;
}
