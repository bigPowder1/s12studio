/** File > New's ME 305 blank_project lookup: candidate order and the first directory holding a usable blank_project/. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findTemplatesDir, templateCandidates, userTemplatesDir } from './templates-dir';

const root = mkdtempSync(join(tmpdir(), 's12-templates-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function stationery(dir: string): string {
  mkdirSync(join(dir, 'blank_project'), { recursive: true });
  writeFileSync(join(dir, 'blank_project', 'blank_project.mcp'), '');
  return dir;
}

describe('templateCandidates', () => {
  const base = { userData: '/u', appDir: '/repo/apps/ide', resourcesPath: '/opt/s12/resources' };

  it('checkout: env override, user data, then the private fixtures', () => {
    expect(templateCandidates({ ...base, env: { S12_TEMPLATES_DIR: '/t' }, packaged: false })).toEqual(['/t', join('/u', 'templates'), join('/repo/apps/ide', '../../fixtures')]);
    expect(templateCandidates({ ...base, env: { S12_FIXTURES: '/private/fx' }, packaged: false })).toEqual([undefined, join('/u', 'templates'), resolve('/private/fx')]);
  });

  it('packaged: user data only (installers bundle no templates), never the fixtures', () => {
    const c = templateCandidates({ ...base, env: { S12_FIXTURES: '/private/fx' }, packaged: true });
    expect(c).toEqual([undefined, join('/u', 'templates'), undefined]);
    expect(c.some((d) => d?.startsWith('/opt/s12/resources'))).toBe(false);
    expect(userTemplatesDir('/u')).toBe(join('/u', 'templates'));
  });
});

describe('findTemplatesDir', () => {
  it('returns the first candidate with a blank_project/*.mcp, skipping missing and empty ones', () => {
    const empty = join(root, 'empty');
    mkdirSync(join(empty, 'blank_project'), { recursive: true }); // no .mcp
    const user = stationery(join(root, 'user'));
    const fixtures = stationery(join(root, 'fixtures'));
    expect(findTemplatesDir([undefined, join(root, 'missing'), empty, user, fixtures])).toBe(resolve(user));
    expect(findTemplatesDir([undefined, join(root, 'missing'), empty])).toBeUndefined();
  });

  it('ignores a blank_project without a .mcp (only main.asm)', () => {
    const partial = join(root, 'partial');
    mkdirSync(join(partial, 'blank_project', 'Sources'), { recursive: true });
    writeFileSync(join(partial, 'blank_project', 'Sources', 'main.asm'), '');
    expect(findTemplatesDir([join(root, 'missing'), partial])).toBeUndefined();
  });
});
