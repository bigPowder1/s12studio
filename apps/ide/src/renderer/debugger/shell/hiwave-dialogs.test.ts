import { describe, expect, it } from 'vitest';
import { FCS_INI as fcsIniText } from '../../common/monaco/testing/hiwave-texts';
import { loadDialogOptionsFromIni, loadDialogPreset, loadOptionsOf } from './hiwave-dialogs';

describe('Load Executable File presets', () => {
  it('reads LoadDialogOptions from the FCS ini', () => {
    expect(loadDialogOptionsFromIni(fcsIniText)).toBe('AUTOERASEANDFLASH NORUNAFTERLOAD');
  });
  it('maps options to dialog state and back to LOAD options', () => {
    const s = loadDialogPreset('AUTOERASEANDFLASH NORUNAFTERLOAD', 'a.abs');
    expect(s).toMatchObject({ path: 'a.abs', autoErase: true, runAfterLoad: false, what: 'all' });
    expect(loadOptionsOf(s)).toEqual(['AUTOERASEANDFLASH', 'NORUNAFTERLOAD']);
    const r = loadDialogPreset('RUNANDSTOPAFTERLOAD="Entry" CODEONLY VERIFYAFTERLOAD');
    expect(r).toMatchObject({ runAfterLoad: true, stopAtFunction: true, stopAt: 'Entry', what: 'code', verify: true });
    expect(loadOptionsOf(r)).toEqual(['CODEONLY', 'VERIFY', 'RUNANDSTOPAFTERLOAD="Entry"']);
    expect(loadOptionsOf({ ...r, stopAtFunction: false, what: 'symbols', verify: false })).toEqual(['SYMBOLSONLY', 'RUNAFTERLOAD']);
  });
});
