import { describe, expect, it } from 'vitest';
import { ASM_OPTION_PAGES, choiceValue, definesValue, flagOn, listingValue, otherOptions, setChoice, setDefines, setFlag, setListing, setOption, splitOptions } from './asm-options';

const LAB3 = '-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li';
const flag = (f: string) => ASM_OPTION_PAGES.flatMap((p) => p.flags ?? []).find((x) => x.flag === f)!;
const choice = (id: string) => ASM_OPTION_PAGES.flatMap((p) => p.choices ?? []).find((x) => x.id === id)!;

describe('assembler option string editing', () => {
  it('splits like the assembler (quotes stay inside a token)', () => {
    expect(splitOptions(' -CpuHCS12X  -env"GENPATH=a b" -Li ')).toEqual(['-CpuHCS12X', '-env"GENPATH=a b"', '-Li']);
  });

  it('reads the Lab3 options', () => {
    expect(choiceValue(LAB3, choice('cpu'))).toBe('-CPUHCS12X');
    expect(choiceValue(' -CpuHCS12X ', choice('cpu'))).toBe('-CPUHCS12X'); // case-insensitive
    expect(listingValue(LAB3)).toBe('%(TEXTPATH)\\%n.lst');
    expect(flagOn(LAB3, flag('-Li'))).toBe(true);
    expect(flagOn(LAB3, flag('-Ci'))).toBe(false);
    expect(otherOptions(LAB3)).toEqual([]);
  });

  it('toggles flags in place and keeps unknown options', () => {
    expect(setFlag(LAB3, flag('-Ci'), true)).toBe(`${LAB3} -Ci`);
    expect(setFlag(LAB3, flag('-Li'), false)).toBe('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst');
    expect(setFlag('-Foo -li', flag('-Li'), false)).toBe('-Foo');
    expect(setChoice(LAB3, choice('cpu'), '-CPUHCS12')).toBe('-CPUHCS12 -L=%(TEXTPATH)\\%n.lst -Li');
    expect(setChoice(LAB3, choice('cpu'), null)).toBe('-L=%(TEXTPATH)\\%n.lst -Li');
    expect(setChoice('-Ms -X', choice('model'), '-Mb')).toBe('-Mb -X');
    expect(setListing(LAB3, null)).toBe('-CPUHCS12X -Li');
    expect(setListing('-CPUHCS12X', '')).toBe('-CPUHCS12X -L');
    expect(setOption('', /^-W[12]$/i, '-W1')).toBe('-W1');
    expect(setOption('-A', /^-B$/, null)).toBe('-A');
  });

  it('edits -D defines', () => {
    expect(definesValue('-CpuHCS12 -D_HCS12_SERIALMON=1 -Ms')).toEqual(['_HCS12_SERIALMON=1']);
    expect(setDefines('-CpuHCS12 -D_A=1 -Ms', ['B', 'C=2'])).toBe('-CpuHCS12 -DB -DC=2 -Ms');
    expect(setDefines('-Ms', ['X'])).toBe('-Ms -DX');
    expect(setDefines('-DX -Ms', [''])).toBe('-Ms');
  });
});
