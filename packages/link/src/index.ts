// @s12/link — SmartLinker V-5.0.40 Build 10203 + Burner clone for HC12 (byte-identical to CodeWarrior S12(X) v5.1).
export { link, orderLinkInputs } from './link';
export { burn, burnFull, absLoadBlocks, FULL_S19_SUFFIX } from './burner';
export type { BurnInput, BurnResult, BurnOutputFile, BurnFullOptions } from './burner';
export { readNoteMeta, linkerCommandLine, ctime } from './note';
export {
  linkerNotes,
  loadSegments,
  DEBUG_SECTION_ORDER,
  SMARTLINKER_PRODUCER,
  SMARTLINKER_VERSION,
  SMARTLINKER_BUILD_DATE,
  NOTE_COMMAND_LINE_MAX,
} from './abs';
export { LinkMessages, formatLinkMessage, isError, CLONE_UNSUPPORTED, CLONE_SUSPICIOUS } from './messages';
export { SECTION_ALIASES, canonicalSection } from './sections';
export type * from './types';
