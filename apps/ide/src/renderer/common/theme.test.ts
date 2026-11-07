// @vitest-environment node
/** theme.css checks that need the real stylesheet text (Vitest's CSS handling empties `?raw` CSS imports). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8');

describe('theme.css', () => {
  it('.cw-menu sets the menu text color, so a cascading submenu does not inherit its highlighted parent item color', () => {
    const rule = /\.cw-menu\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/(^|;|\s)color:\s*var\(--cw-window-text\)/);
  });
});
