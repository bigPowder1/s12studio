/** IDE File > Exit: "save changes?" for every modified document first; Cancel keeps the app (and the debugger). */
import { afterEach, describe, expect, it } from 'vitest';
import { createMockS12 } from '../../common/testing/mockS12';
import { setEditorArea, type EditorAreaHandle } from '../editor/bridge';
import { lab3Info } from '../testing/lab3-model';
import { createIdeActions } from './actions';

const editor = (ok: boolean) => ({ closeAll: async () => ok }) as unknown as EditorAreaHandle;

afterEach(() => setEditorArea(null));

describe('File > Exit', () => {
  it('Cancel at a save prompt does not quit', async () => {
    const m = createMockS12();
    setEditorArea(editor(false));
    await createIdeActions(m.api, () => lab3Info()).quit();
    expect(m.calls('app', 'quit')).toHaveLength(0);
  });

  it('quits once every document was saved or discarded', async () => {
    const m = createMockS12();
    setEditorArea(editor(true));
    await createIdeActions(m.api, () => lab3Info()).quit();
    expect(m.calls('app', 'quit')).toHaveLength(1);
  });
});
