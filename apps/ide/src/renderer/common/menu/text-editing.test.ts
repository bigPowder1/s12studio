import { describe, expect, it } from 'vitest';
import { isTextEditingShortcut } from './MenuBar';

describe('isTextEditingShortcut', () => {
  it('leaves clipboard/undo/caret keys to text fields and lets other shortcuts reach the menus', () => {
    for (const s of ['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Home', 'Shift+End', 'Ctrl+ArrowLeft', 'A', 'Shift+A', 'Delete']) expect(isTextEditingShortcut(s)).toBe(true);
    for (const s of ['Ctrl+S', 'Ctrl+O', 'Ctrl+F', 'F7', 'Ctrl+F7', 'Alt+F7', 'Shift+F3', 'F5']) expect(isTextEditingShortcut(s)).toBe(false);
  });
});
