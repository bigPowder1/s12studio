// DWARF 2 constants (subset used by CodeWarrior HC12 output, plus common ones for the generic reader).

export const DW_TAG = {
  array_type: 0x01,
  entry_point: 0x03,
  enumeration_type: 0x04,
  formal_parameter: 0x05,
  label: 0x0a,
  lexical_block: 0x0b,
  member: 0x0d,
  pointer_type: 0x0f,
  compile_unit: 0x11,
  structure_type: 0x13,
  subroutine_type: 0x15,
  typedef: 0x16,
  union_type: 0x17,
  inlined_subroutine: 0x1d,
  subrange_type: 0x21,
  base_type: 0x24,
  const_type: 0x26,
  enumerator: 0x28,
  subprogram: 0x2e,
  variable: 0x34,
  volatile_type: 0x35,
} as const;

export const DW_AT = {
  sibling: 0x01,
  location: 0x02,
  name: 0x03,
  byte_size: 0x0b,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  comp_dir: 0x1b,
  const_value: 0x1c,
  lower_bound: 0x22,
  producer: 0x25,
  upper_bound: 0x2f,
  bit_stride: 0x2e, // DW_AT_stride_size in DWARF 2
  decl_file: 0x3a,
  decl_line: 0x3b,
  encoding: 0x3e,
  external: 0x3f,
  frame_base: 0x40,
  type: 0x49,
} as const;

export const DW_FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  ref_addr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  ref_udata: 0x15,
  indirect: 0x16,
} as const;

export const DW_ATE = {
  address: 0x1,
  boolean: 0x2,
  float: 0x4,
  signed: 0x5,
  signed_char: 0x6,
  unsigned: 0x7,
  unsigned_char: 0x8,
} as const;

export const DW_OP_addr = 0x03;

export const DW_LNS = {
  copy: 1,
  advance_pc: 2,
  advance_line: 3,
  set_file: 4,
  set_column: 5,
  negate_stmt: 6,
  set_basic_block: 7,
  const_add_pc: 8,
  fixed_advance_pc: 9,
} as const;

export const DW_LNE = {
  end_sequence: 1,
  set_address: 2,
  define_file: 3,
} as const;

/** CodeWarrior's vendor language code for assembly (readelf prints "Move"). */
export const DW_LANG_CW_ASM = 0x41;
