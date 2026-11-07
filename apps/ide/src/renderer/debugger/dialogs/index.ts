/**
 * Debugger dialogs (owned by the dbg-data track). The shell opens ControlpointsDialog for Run > Control Points...;
 * components use AddressDialog, FillMemoryDialog and PromptDialog for their menus.
 */
export { AddressDialog, type AddressDialogProps } from './AddressDialog';
export { ControlpointsDialog, type ControlpointsDialogProps, type ControlpointsTab } from './ControlpointsDialog';
export { FillMemoryDialog, type FillMemoryDialogProps } from './FillMemoryDialog';
export { PromptDialog, intRange, type PromptDialogProps } from './PromptDialog';
export { markpoints, useMarkpoints, type Markpoint } from './markpoints';
export { hexText, resolveAddress } from './resolve';
export { useBreakpoints, useWatchpoints } from './useControlpoints';
export { CopyMemDialog, type CopyMemDialogProps } from './CopyMemDialog';
export { SearchPatternDialog, type SearchPatternDialogProps } from './SearchPatternDialog';
export { DialogLayer, inDialog } from './DialogLayer';
export { copyMemory, indexOfPattern, parsePattern, searchMemory } from './memtools';
