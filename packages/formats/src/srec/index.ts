export {
  readSRecords,
  writeSRecords,
  formatSRecord,
  mergeSRecordBlocks,
  chooseSRecordType,
  recordTypeFor,
  SRECORD_MAX_HEADER_BYTES,
  SRecordParseError,
} from './srec';
export type { SRecord, SRecordBlock, SRecordFile, SRecordError, SRecordDataType, SRecordWriteOptions } from './srec';
