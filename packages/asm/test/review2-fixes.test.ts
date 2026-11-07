/**
 * Regression tests for the round-2 review findings: no exception escapes assemble() on pathological expressions,
 * DCB with an out-of-range count, -ObjN special modifiers / OBJPATH, .dbg in OBJPATH, -Lasms1 "Loc" header.
 */
import { describe, expect, it } from 'vitest';
import { assemble, LI_EXCLUDES_INCLUDES_FROM_DBG, MAX_EXPR_NESTING, type AssembleInput } from '../src/index.js';
import { asmSource, hex, sectionBytes } from './helpers.js';

const codes = (r: { messages: Array<{ code: string }> }) => r.messages.map((m) => m.code);

describe('pathological expressions report A9002 instead of throwing', () => {
  it('300 nested parentheses', () => {
    const r = asmSource(` ORG 0\n DC.B ${'('.repeat(300)}1${')'.repeat(300)}\n NOP\n`);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['A9002']);
    expect(r.messages[0].line).toBe(2);
    expect(r.messages[0].text).toMatch(/Internal assembler error: expression too complex/);
  });
  it('20000 unary minus and a 20000-term sum', () => {
    expect(codes(asmSource(` ORG 0\n DC.B ${'-'.repeat(20000)}1\n`))).toEqual(['A9002']);
    expect(codes(asmSource(` ORG 0\n DC.W 1${'+1'.repeat(20000)}\n`))).toEqual(['A9002']);
    expect(codes(asmSource(` ORG 0\n LDAA #${'('.repeat(5000)}1${')'.repeat(5000)}\n`))).toEqual(['A9002']);
  });
  it('nesting up to the limit still assembles', () => {
    const n = MAX_EXPR_NESTING - 1;
    const r = asmSource(` ORG 0\n DC.B ${'('.repeat(n)}7${')'.repeat(n)}\n DC.B ${'-'.repeat(50)}1\n DC.W 0${'+1'.repeat(999)}\n`);
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('07 01 03 E7');
  });
  it('an unexpected internal exception becomes an A9002 message', () => {
    const input: AssembleInput = {
      sourcePath: 'x.asm',
      readFile: () => {
        throw new TypeError('boom');
      },
    };
    const r = assemble(input);
    expect(r.ok).toBe(false);
    expect(r.messages.map((m) => [m.code, m.severity, m.text])).toEqual([['A9002', 'ERROR', 'Internal assembler error: boom']]);
  });
});

describe('DCB with an out-of-range count', () => {
  it('gives only A2321 / A2320, no phase error, and allocates nothing', () => {
    expect(codes(asmSource(' ORG 0\n dcb.b 5000,1\n'))).toEqual(['A2321']);
    expect(codes(asmSource(' ORG 0\n dcb.w 0,1\n'))).toEqual(['A2320']);
    expect(codes(asmSource(' ORG 0\n dcb.b -3,1\n'))).toEqual(['A2320']);
  });
  it('in-range counts are unchanged', () => {
    const r = asmSource(' ORG 0\n dcb.b 3,$AA\n dcb.w 1,$1234\n');
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('AA AA AA 12 34');
  });
});

describe('output paths', () => {
  const run = (options: string, env: Record<string, string>) =>
    assemble({ sourcePath: 'C:\\p\\Sources\\main.asm', readFile: () => ' NOP\n', options, env });
  it('-ObjN expands special modifiers and %(ENV)', () => {
    expect(run('-ObjN%n.obj', {}).objectPath).toBe('C:\\p\\Sources\\main.obj');
    expect(run('-objn=%(OBJPATH)\\%n.o', { OBJPATH: 'C:\\p\\obj' }).objectPath).toBe('C:\\p\\obj\\main.o');
    expect(run('-objn"C:\\x y\\main.asm.o"', { OBJPATH: 'C:\\p\\obj' }).objectPath).toBe('C:\\x y\\main.asm.o');
  });
  it('a name without a directory goes to the first OBJPATH entry; default -ObjN%n.o', () => {
    expect(run('-ObjNa.out', { OBJPATH: 'C:\\o1;C:\\o2' }).objectPath).toBe('C:\\o1\\a.out');
    expect(run('', { OBJPATH: 'C:\\o1' }).objectPath).toBe('C:\\o1\\main.o');
    expect(run('', {}).objectPath).toBe('C:\\p\\Sources\\main.o');
  });
  it('.dbg goes to the first OBJPATH entry, the .lst to the first TEXTPATH entry', () => {
    const r = run('-L', { OBJPATH: 'C:\\obj;C:\\other', TEXTPATH: 'C:\\txt;C:\\t2' });
    expect(r.dbg.path).toBe('C:\\obj\\main.dbg');
    expect(r.listing!.path).toBe('C:\\txt\\main.lst');
    const s = run('-L=x.lst', {});
    expect(s.dbg.path).toBe('C:\\p\\Sources\\main.dbg');
    expect(s.listing!.path).toBe('C:\\p\\Sources\\x.lst');
  });
});

describe('recursive GENPATH entries (path*)', () => {
  const files: Record<string, string> = { 'C:\\p\\Sources\\main.asm': ' INCLUDE "deep.inc"\n ORG 0\n DC.B V\n', 'C:\\lib\\a\\b\\deep.inc': 'V: EQU 9\n' };
  const subdirs: Record<string, string[]> = { 'C:\\lib': ['C:\\lib\\a'], 'C:\\lib\\a': ['C:\\lib\\a\\b'] };
  const run = (genpath: string, listSubdirs?: (d: string) => string[] | undefined) =>
    assemble({ sourcePath: 'C:\\p\\Sources\\main.asm', readFile: (p) => files[p], env: { GENPATH: genpath }, listSubdirs });
  it('searches subfolders through the host listSubdirs callback', () => {
    const r = run('C:\\other;C:\\lib*', (d) => subdirs[d]);
    expect(r.messages).toEqual([]);
    expect(r.includes).toEqual(['C:\\lib\\a\\b\\deep.inc']);
    expect(run('C:\\lib\\*', (d) => subdirs[d]).ok).toBe(true);
  });
  it('without the callback or without * only the folder itself is searched', () => {
    expect(run('C:\\lib*').ok).toBe(false);
    expect(run('C:\\lib', (d) => subdirs[d]).ok).toBe(false);
    expect(run('C:\\lib\\a\\b*').ok).toBe(true);
  });
  it('survives cyclic directory listings', () => {
    expect(run('C:\\lib*', (d) => (d === 'C:\\lib' ? ['C:\\lib\\a', 'C:\\lib'] : d === 'C:\\lib\\a' ? ['C:\\LIB', 'C:\\lib\\a\\b'] : [])).ok).toBe(true);
  });
});

describe('liExcludesIncludesFromDbg override', () => {
  const files = { 'inc.inc': 'V: EQU 1\nW: EQU 2\n' };
  it('defaults to LI_EXCLUDES_INCLUDES_FROM_DBG and can be flipped per call', () => {
    const src = ' INCLUDE "inc.inc"\n ORG 0\n DC.B V+W\n';
    const def = asmSource(src, '-CpuHCS12X -L -Li', files);
    const flip = asmSource(src, '-CpuHCS12X -L -Li', files, { liExcludesIncludesFromDbg: !LI_EXCLUDES_INCLUDES_FROM_DBG });
    const n = (r: typeof def) => r.dbg.text.split('\r\n').length - 1;
    expect(Math.abs(n(def) - n(flip))).toBe(2);
    expect(def.listing!.text).not.toContain('V: EQU 1');
    expect(flip.listing!.text).not.toContain('V: EQU 1');
    expect(hex(sectionBytes(flip, '_ORG00001'))).toBe('03');
  });
});
