// Generic DWARF 2 .debug_line decoder.
import { ByteReader } from '../util/bytes';
import { DW_LNE, DW_LNS } from './constants';
import { DwarfError } from './info';

export interface LineFileEntry {
  name: string;
  dir: number;
  mtime: number;
  length: number;
}

export interface LineProgramHeader {
  /** Offset of the program within .debug_line. */
  offset: number;
  unitLength: number;
  version: number;
  headerLength: number;
  minInstLength: number;
  defaultIsStmt: boolean;
  lineBase: number;
  lineRange: number;
  opcodeBase: number;
  standardOpcodeLengths: number[];
  includeDirs: string[];
  files: LineFileEntry[];
  /** Offset of the first opcode. */
  programOffset: number;
  /** Offset just past the program. */
  end: number;
}

export interface LineRow {
  address: number;
  /** 1-based file index. */
  file: number;
  line: number;
  column: number;
  isStmt: boolean;
  basicBlock: boolean;
  endSequence: boolean;
}

/** One decoded opcode (for diagnostics / exact re-encoding checks). */
export interface LineOp {
  offset: number;
  opcode: number;
  /** Extended opcode number, when opcode === 0. */
  ext?: number;
  operand?: number;
  /** Offset of the set_address operand within .debug_line (for relocations). */
  operandOffset?: number;
}

export interface LineProgram {
  header: LineProgramHeader;
  rows: LineRow[];
  ops: LineOp[];
}

export function parseLineProgramHeader(data: Uint8Array, offset = 0): LineProgramHeader {
  const r = new ByteReader(data, offset);
  const unitLength = r.u32();
  const end = offset + 4 + unitLength;
  const version = r.u16();
  if (version < 2 || version > 3) throw new DwarfError(`unsupported .debug_line version ${version}`);
  const headerLength = r.u32();
  const programOffset = r.pos + headerLength;
  const minInstLength = r.u8();
  const defaultIsStmt = r.u8() !== 0;
  const lineBase = r.i8();
  const lineRange = r.u8();
  const opcodeBase = r.u8();
  const standardOpcodeLengths: number[] = [];
  for (let i = 1; i < opcodeBase; i++) standardOpcodeLengths.push(r.u8());
  const includeDirs: string[] = [];
  for (;;) {
    const s = r.cstr();
    if (!s) break;
    includeDirs.push(s);
  }
  const files: LineFileEntry[] = [];
  for (;;) {
    const name = r.cstr();
    if (!name) break;
    files.push({ name, dir: r.uleb128(), mtime: r.uleb128(), length: r.uleb128() });
  }
  if (r.pos !== programOffset) throw new DwarfError(`line header length mismatch at 0x${offset.toString(16)}`);
  return {
    offset,
    unitLength,
    version,
    headerLength,
    minInstLength,
    defaultIsStmt,
    lineBase,
    lineRange,
    opcodeBase,
    standardOpcodeLengths,
    includeDirs,
    files,
    programOffset,
    end,
  };
}

/** Decode one line-number program into its row matrix. */
export function parseLineProgram(data: Uint8Array, offset = 0, addressSize = 4): LineProgram {
  const header = parseLineProgramHeader(data, offset);
  const r = new ByteReader(data.subarray(0, header.end), header.programOffset);
  const rows: LineRow[] = [];
  const ops: LineOp[] = [];
  const reset = () => ({ address: 0, file: 1, line: 1, column: 0, isStmt: header.defaultIsStmt, basicBlock: false });
  let st = reset();
  const emit = (endSequence: boolean) => {
    rows.push({ ...st, endSequence });
    st.basicBlock = false;
  };
  while (!r.eof) {
    const opOff = r.pos;
    const op = r.u8();
    if (op >= header.opcodeBase) {
      const adj = op - header.opcodeBase;
      st.address += Math.floor(adj / header.lineRange) * header.minInstLength;
      st.line += header.lineBase + (adj % header.lineRange);
      emit(false);
      ops.push({ offset: opOff, opcode: op });
      continue;
    }
    if (op === 0) {
      const len = r.uleb128();
      const next = r.pos + len;
      const ext = r.u8();
      const o: LineOp = { offset: opOff, opcode: 0, ext };
      if (ext === DW_LNE.end_sequence) {
        emit(true);
        st = reset();
      } else if (ext === DW_LNE.set_address) {
        o.operandOffset = r.pos;
        st.address = r.uN(len - 1 || addressSize);
        o.operand = st.address;
      }
      // define_file and unknown extended opcodes are skipped.
      r.seek(next);
      ops.push(o);
      continue;
    }
    const o: LineOp = { offset: opOff, opcode: op };
    switch (op) {
      case DW_LNS.copy:
        emit(false);
        break;
      case DW_LNS.advance_pc:
        o.operand = r.uleb128();
        st.address += o.operand * header.minInstLength;
        break;
      case DW_LNS.advance_line:
        o.operand = r.sleb128();
        st.line += o.operand;
        break;
      case DW_LNS.set_file:
        o.operand = r.uleb128();
        st.file = o.operand;
        break;
      case DW_LNS.set_column:
        o.operand = r.uleb128();
        st.column = o.operand;
        break;
      case DW_LNS.negate_stmt:
        st.isStmt = !st.isStmt;
        break;
      case DW_LNS.set_basic_block:
        st.basicBlock = true;
        break;
      case DW_LNS.const_add_pc:
        st.address += Math.floor((255 - header.opcodeBase) / header.lineRange) * header.minInstLength;
        break;
      case DW_LNS.fixed_advance_pc:
        o.operand = r.u16();
        st.address += o.operand;
        break;
      default: {
        // Unknown standard opcode: skip its uleb operands.
        const n = header.standardOpcodeLengths[op - 1] ?? 0;
        for (let i = 0; i < n; i++) r.uleb128();
      }
    }
    ops.push(o);
  }
  return { header, rows, ops };
}

/** Decode every line program in a .debug_line section (concatenated units, e.g. a linked .abs). */
export function parseDebugLine(data: Uint8Array, addressSize = 4): LineProgram[] {
  const out: LineProgram[] = [];
  let off = 0;
  while (off + 4 <= data.length) {
    const p = parseLineProgram(data, off, addressSize);
    out.push(p);
    off = p.header.end;
  }
  return out;
}
