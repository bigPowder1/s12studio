import { describe, expect, it, vi } from 'vitest';
import { lab3Target } from '../testing/lab3-model';
import { applyCalls, diffDraft, draftDirty, draftFromTarget, factoryDraft, panelDirty, resetPanel, toAccessPath, validateDraft } from './target-settings-model';
import type { ProjectApi } from '../../../shared/api';

describe('target settings model', () => {
  const base = draftFromTarget(lab3Target());

  it('drafts the target', () => {
    expect(base.outputDir).toBe('{Project}bin');
    expect(base.userPaths[0]).toBe('{Project}');
    expect(base.systemPaths).toEqual(['{Compiler}lib\\HC12c\\include']);
    expect(base.options.assembler).toBe('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li');
    expect(base.debuggerArgs).toContain('P&E_Multilink_USB.ini');
  });

  it('diffs into the contract calls (only what changed)', () => {
    expect(diffDraft('Standard', base, base)).toEqual([]);
    const d = { ...base, outputFile: 'Lab3.abs', userPaths: base.userPaths.slice(1), options: { ...base.options, assembler: '-CPUHCS12X -Ci', linker: '-M' }, debuggerArgs: 'x' };
    expect(diffDraft('Standard', base, d)).toEqual([
      { method: 'setOutput', args: ['Standard', { file: 'Lab3.abs' }] },
      { method: 'setAccessPaths', args: ['Standard', { user: base.userPaths.slice(1), system: base.systemPaths }] },
      { method: 'setOption', args: ['Standard', 'assembler', '-CPUHCS12X -Ci'] },
      { method: 'setOption', args: ['Standard', 'linker', '-M'] },
      { method: 'setDebuggerArgs', args: ['Standard', 'x'] },
    ]);
  });

  it('revert / factory per panel, dirty tracking, validation', () => {
    const d = { ...base, options: { ...base.options, assembler: '-X' }, outputDir: 'out' };
    expect(draftDirty(base, d)).toBe(true);
    expect(panelDirty(base, d, 'assembler')).toBe(true);
    expect(panelDirty(base, d, 'linker')).toBe(false);
    const r = resetPanel(d, 'assembler', base);
    expect(r.options.assembler).toBe(base.options.assembler);
    expect(r.outputDir).toBe('out');
    expect(resetPanel(d, 'targetSettings', factoryDraft()).outputDir).toBe('{Project}bin');
    expect(resetPanel(base, 'accessPaths', factoryDraft()).userPaths).toEqual(factoryDraft().userPaths);
    expect(validateDraft({ ...base, outputFile: 'a/b.abs' })).toHaveLength(1);
    expect(validateDraft(base)).toEqual([]);
  });

  it('applyCalls runs them in order', async () => {
    const order: string[] = [];
    const api = { setOutput: vi.fn(async () => (order.push('o'), null)), setOption: vi.fn(async () => (order.push('s'), { name: 'P' })) } as unknown as ProjectApi;
    const r = await applyCalls(api, [
      { method: 'setOutput', args: ['T', { dir: 'x' }] },
      { method: 'setOption', args: ['T', 'assembler', '-A'] },
    ]);
    expect(order).toEqual(['o', 's']);
    expect(r).toEqual({ name: 'P' });
  });

  it('access paths in CodeWarrior form', () => {
    expect(toAccessPath('/p/Lab3', '/p/Lab3')).toBe('{Project}');
    expect(toAccessPath('/p/Lab3', '/p/Lab3/Sources/Libraries')).toBe('{Project}Sources\\Libraries');
    expect(toAccessPath('C:\\x\\Lab3', 'C:\\x\\Lab3\\bin')).toBe('{Project}bin');
    expect(toAccessPath('/p/Lab3', '/q/libs')).toBe('/q/libs');
  });
});
