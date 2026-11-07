// Decoders for the .mcp 'pref' settings panels. Spec: docs/research/r2/mcp-format.md §2.5.
// Offsets are relative to the chunk data. All decoders are tolerant: short chunks yield partial results + warnings.
import { LoocReader, cstr } from '../looc/container';

/** Path root as stored in CodeWarrior path records. */
export type McpPathRoot = 'absolute' | 'project' | 'compiler' | 'system' | `root${number}`;

export function pathRootName(root: number): McpPathRoot {
  switch (root) {
    case 0: return 'absolute';
    case 1: return 'project';
    case 2: return 'compiler';
    // UNCERTAIN: 3 is assumed to be {System} (classic CW "System" tree); never seen in fixtures.
    case 3: return 'system';
    default: return `root${root}`;
  }
}

/** Render as CodeWarrior shows it, e.g. `{Project}bin`, `{Compiler}lib\HC12c\include`. */
export function formatRootedPath(root: McpPathRoot, path: string): string {
  switch (root) {
    case 'absolute': return path;
    case 'project': return `{Project}${path}`;
    case 'compiler': return `{Compiler}${path}`;
    case 'system': return `{System}${path}`;
    default: return `{${root}}${path}`;
  }
}

export interface McpRootedPath {
  root: McpPathRoot;
  /** 1 = Mac, 2 = Windows (UNCERTAIN beyond 2) */
  format: number;
  path: string;
  /** `{Project}bin` style rendering */
  display: string;
}

function rooted(r: LoocReader, o: number, maxLen: number): McpRootedPath {
  const root = pathRootName(r.u16(o));
  const format = r.u16(o + 2);
  const path = r.cstr(o + 4, maxLen);
  return { root, format, path, display: formatRootedPath(root, path) };
}

// ---------------------------------------------------------------- Target Settings
export interface McpTargetSettings {
  version: number;
  linker: string;
  preLinker: string;
  postLinker: string;
  targetName: string;
  outputDir: McpRootedPath;
}

export function decodeTargetSettings(r: LoocReader, size: number, warnings: string[]): McpTargetSettings | undefined {
  if (size < 0x408 + 1) {
    warnings.push(`Target Settings panel too short (${size} bytes)`);
    return undefined;
  }
  return {
    version: r.u32(0),
    linker: r.cstr(0x04, 256),
    preLinker: r.cstr(0x104, 256),
    postLinker: r.cstr(0x204, 256),
    targetName: r.cstr(0x304, 256),
    outputDir: rooted(r, 0x404, Math.min(512, size - 0x408)),
  };
}

// ---------------------------------------------------------------- Access Paths
export interface McpAccessPath extends McpRootedPath {
  /** record id with the 0x40000000 flag bit stripped */
  id: number;
  /** raw id word, including any flag bits. UNCERTAIN: 0x40000000 may be the Recursive/host flag */
  rawId: number;
  /** the 16 trailing bytes of the record (flags not yet decoded; UNCERTAIN) */
  extra: Uint8Array;
}

export interface McpAccessPaths {
  user: McpAccessPath[];
  system: McpAccessPath[];
}

const AP_HEADER = 0x10; // u32 0x10, u32 0, u16 userCount, u16 systemCount, u32 (next id?)
const AP_STRIDE = 0x218; // u32 id, u16 root, u16 fmt, char path[512], u8 extra[16]

function plausibleAp(r: LoocReader, o: number): boolean {
  const root = r.u16(o + 4), fmt = r.u16(o + 6);
  return root <= 3 && fmt >= 1 && fmt <= 2;
}

function readAp(r: LoocReader, o: number, size: number): McpAccessPath {
  const rawId = r.u32(o);
  const rp = rooted(r, o + 4, Math.min(512, size - (o + 8)));
  const extraOff = o + 8 + 512;
  return { ...rp, id: rawId & 0x3fffffff, rawId, extra: r.bytes.slice(Math.min(extraOff, size), Math.min(extraOff + 16, size)) };
}

export function decodeAccessPaths(r: LoocReader, size: number, warnings: string[]): McpAccessPaths {
  const out: McpAccessPaths = { user: [], system: [] };
  if (size < AP_HEADER) {
    warnings.push('Access Paths panel too short');
    return out;
  }
  const nUser = r.u16(8), nSys = r.u16(10);
  const total = nUser + nSys;
  // UNCERTAIN: record alignment derived from Lab3 only (records at 0x10 + i*0x218). Validate and fall back to a marker scan.
  let ok = AP_HEADER + total * AP_STRIDE <= size;
  for (let i = 0; ok && i < total; i++) ok = plausibleAp(r, AP_HEADER + i * AP_STRIDE);
  let recs: McpAccessPath[] = [];
  if (ok) {
    for (let i = 0; i < total; i++) recs.push(readAp(r, AP_HEADER + i * AP_STRIDE, size));
  } else {
    warnings.push('Access Paths records not at the expected stride; using FFFFFFFF marker scan');
    recs = scanAccessPaths(r, size);
  }
  out.user = recs.slice(0, nUser);
  out.system = recs.slice(nUser, nUser + nSys);
  if (recs.length < total) warnings.push(`Access Paths: expected ${total} records, found ${recs.length}`);
  return out;
}

function scanAccessPaths(r: LoocReader, size: number): McpAccessPath[] {
  const out: McpAccessPath[] = [];
  // the first record is not preceded by a marker: it sits right after the header
  if (size >= AP_HEADER + 8 && plausibleAp(r, AP_HEADER)) out.push(readAp(r, AP_HEADER, size));
  for (let o = AP_HEADER + 8; o + 12 <= size; o += 4) {
    if (r.u32(o) === 0xffffffff && plausibleAp(r, o + 4) && o + 12 < size) {
      out.push(readAp(r, o + 4, size));
      o += 8 + 512;
    }
  }
  return out;
}

// ---------------------------------------------------------------- File Mappings
export interface McpFileMapping {
  /** FourCC file type ('TEXT', 'MMPr', ...) or '' when 0 */
  fileType: string;
  extension: string;
  compiler: string;
  editLanguage: string;
  flags: number;
  /** UNCERTAIN bit names: 0x10 ignored-by-make, 0x20 resource, 0x40 launchable, 0x80 precompile */
  ignoredByMake: boolean;
  launchable: boolean;
  precompile: boolean;
  resourceFile: boolean;
}

export interface McpFileMappingSection {
  linker: string;
  mappings: McpFileMapping[];
}

export function decodeFileMappings(r: LoocReader, size: number, warnings: string[]): McpFileMappingSection[] {
  const out: McpFileMappingSection[] = [];
  if (size < 4) return out;
  const nSec = r.u16(2);
  let o = 4;
  for (let s = 0; s < nSec; s++) {
    if (o + 36 > size) {
      warnings.push('File Mappings truncated');
      break;
    }
    const linker = r.cstr(o, 32);
    const count = r.u32(o + 32);
    o += 36;
    const mappings: McpFileMapping[] = [];
    for (let i = 0; i < count; i++) {
      if (o + 104 > size) {
        warnings.push('File Mappings record truncated');
        break;
      }
      const ft = r.u32(o);
      // The flag word is stored big-endian even in LE files (0x10 sits in the last byte). UNCERTAIN: may be 4 separate u8s.
      const flags = ((r.u8(o + 100) << 24) | (r.u8(o + 101) << 16) | (r.u8(o + 102) << 8) | r.u8(o + 103)) >>> 0;
      mappings.push({
        fileType: ft === 0 ? '' : r.fourcc(o),
        extension: r.cstr(o + 4, 32),
        compiler: r.cstr(o + 36, 32),
        editLanguage: r.cstr(o + 68, 32),
        flags,
        ignoredByMake: (flags & 0x10) !== 0,
        resourceFile: (flags & 0x20) !== 0,
        launchable: (flags & 0x40) !== 0,
        precompile: (flags & 0x80) !== 0,
      });
      o += 104;
    }
    out.push({ linker, mappings });
  }
  return out;
}

// ---------------------------------------------------------------- Build Extras
export interface McpBuildExtras {
  version: number;
  /** six u8 flags at bytes 2..7. UNCERTAIN which is "Use external debugger" */
  flags: number[];
  debuggerApp: McpRootedPath;
  args: string;
  initialDir: McpRootedPath;
}

export function decodeBuildExtras(r: LoocReader, size: number, warnings: string[]): McpBuildExtras | undefined {
  // Layout verified on Lab3: u16 ver; u8 flags[6]; @0x08 rooted app[512]; @0x20C 8 bytes (UNCERTAIN);
  // @0x214 args[512]; @0x414 rooted initialDir[512].
  if (size < 0x418) {
    warnings.push(`Build Extras panel too short (${size} bytes)`);
    return undefined;
  }
  const flags: number[] = [];
  for (let i = 2; i < 8; i++) flags.push(r.u8(i));
  return {
    version: r.u16(0),
    flags,
    debuggerApp: rooted(r, 0x08, 512),
    args: r.cstr(0x214, 512),
    initialDir: rooted(r, 0x414, Math.min(512, size - 0x418)),
  };
}

// ---------------------------------------------------------------- HIWARE "Panel for <Tool>" field blobs
export interface McpFieldBlob {
  /** raw field byte arrays */
  fields: Uint8Array[];
  /** field0 as a C string: the tool's extra command-line options (authoritative) */
  options: string;
}

export function decodeFieldBlob(r: LoocReader, size: number, warnings: string[], name = 'panel'): McpFieldBlob | undefined {
  if (size < 0x18) {
    warnings.push(`${name}: field blob too short`);
    return undefined;
  }
  const dataOff = r.u32(4), dirOff = r.u32(8), n = r.u32(12);
  if (dirOff + 4 * n > size || dataOff > size || n > 1024) {
    warnings.push(`${name}: field blob directory out of range`);
    return undefined;
  }
  const fields: Uint8Array[] = [];
  let p = dataOff;
  for (let i = 0; i < n; i++) {
    const len = r.u32(dirOff + 4 * i);
    if (p + len > size) {
      warnings.push(`${name}: field ${i} truncated`);
      break;
    }
    fields.push(r.bytes.slice(p, p + len));
    p += len;
  }
  return { fields, options: fields.length > 0 ? cstr(fields[0], 0) : '' };
}

/** Field as a C string (empty if absent). */
export function blobString(b: McpFieldBlob | undefined, i: number): string {
  const f = b?.fields[i];
  return f && f.length > 0 ? cstr(f, 0) : '';
}

/** Field as a little-endian u32 (undefined if not 4 bytes). */
export function blobU32(b: McpFieldBlob | undefined, i: number, le = true): number | undefined {
  const f = b?.fields[i];
  if (!f || f.length !== 4) return undefined;
  return new DataView(f.buffer, f.byteOffset, 4).getUint32(0, le);
}
