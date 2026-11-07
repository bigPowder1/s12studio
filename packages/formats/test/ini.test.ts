import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, readFixture, itFx, hasFixtures } from './fixtures';
import { IniDocument, parseIni } from '../src/text/ini';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const INIS = !hasFixtures ? [] : walk(FIXTURES).filter((p) => p.toLowerCase().endsWith('.ini'));

describe('INI document', () => {
  itFx('finds all fixture .ini files', () => {
    expect(INIS.length).toBe(10);
  });

  for (const p of INIS) {
    itFx(`round-trips ${p.slice(FIXTURES.length)} byte-identically`, () => {
      const text = readFixture(p.slice(FIXTURES.length)).toString('latin1');
      const doc = parseIni(text);
      expect(doc.toString()).toBe(text);
      expect(doc.eol).toBe('\r\n');
    });
  }

  itFx('reads hiwave project settings from P&E_Multilink_USB.ini', () => {
    const doc = parseIni(readFixture('Lab3', 'P&E_Multilink_USB.ini').toString('latin1'));
    expect(doc.sections()).toEqual([
      'STARTUP',
      'Environment Variables',
      'HI-WAVE',
      'HC12MultilinkCyclonePro_GDI_SETTINGS',
      'ICD12',
      'PORT',
      'Recent Applications File List',
      'Recent Layout File List',
    ]);
    expect(doc.get('HI-WAVE', 'Target')).toBe('icd12');
    expect(doc.get('hi-wave', 'LAYOUT')).toBe('ASM_layout.hwl');
    expect(doc.get('HI-WAVE', 'MainFrame')).toBe('2,3,-1,-1,-1,-1,1284,12,2520,1025');
    expect(doc.get('Environment Variables', 'TEXTPATH')).toBe('{Project}bin');
    expect(doc.get('HC12MultilinkCyclonePro_GDI_SETTINGS', 'CMDFILE3')).toBe('CMDFILE POSTLOAD ON ".\\cmd\\P&E_Multilink_USB_postload.cmd"');
    expect(doc.get('HC12MultilinkCyclonePro_GDI_SETTINGS', 'MCUID')).toBe('0x03F0');
    expect(doc.get('PORT', 'IP')).toBe('');
    expect(doc.get('HI-WAVE', 'nope')).toBeUndefined();
    expect(doc.entries('Recent Layout File List')).toEqual([
      ['File0', 'ASM_layout.hwl'],
      ['File1', ''],
      ['File2', ''],
      ['File3', ''],
    ]);
  });

  itFx('Lab3 and blank differ only in MainFrame; set() turns one into the other', () => {
    const lab = readFixture('Lab3', 'P&E_Multilink_USB.ini').toString('latin1');
    const blank = readFixture('blank_project', 'P&E_Multilink_USB.ini').toString('latin1');
    expect(lab).not.toBe(blank);
    const b = parseIni(blank);
    b.set('HI-WAVE', 'MainFrame', parseIni(lab).get('HI-WAVE', 'MainFrame')!);
    expect(b.toString()).toBe(lab);
  });

  itFx('Full_Chip_Simulation.ini simulator keys', () => {
    const doc = parseIni(readFixture('Lab3', 'Full_Chip_Simulation.ini').toString('latin1'));
    expect(doc.get('Simulator HC12', 'FCS')).toBe('MC9S12XDP512');
    expect(doc.get('HI-WAVE', 'Target')).toBe('sim');
    expect(doc.getAll('Simulator HC12', 'CMDFILE2')).toEqual(['CMDFILE POSTLOAD ON ".\\cmd\\Full_Chip_Simulation_postload.cmd"']);
  });

  it('inserts new keys at the end of a section, before trailing blank lines', () => {
    const doc = parseIni('[A]\r\nx=1\r\n\r\n[B]\r\ny=2\r\n');
    doc.set('A', 'z', '3');
    doc.set('B', 'w', '4');
    doc.set('C', 'k', 'v');
    expect(doc.toString()).toBe('[A]\r\nx=1\r\nz=3\r\n\r\n[B]\r\ny=2\r\nw=4\r\n[C]\r\nk=v\r\n');
  });

  it('preserves comments, odd spacing and duplicate keys; set rewrites the first occurrence only', () => {
    const src = '; top\n[S]\n  key = a \nkey=b\n# hash\ngarbage line\n';
    const doc = parseIni(src);
    expect(doc.eol).toBe('\n');
    expect(doc.toString()).toBe(src);
    expect(doc.get('s', 'KEY')).toBe('a');
    expect(doc.getAll('S', 'key')).toEqual(['a', 'b']);
    doc.set('S', 'key', 'c');
    expect(doc.toString()).toBe('; top\n[S]\n  key =c\nkey=b\n# hash\ngarbage line\n');
    expect(doc.delete('S', 'key')).toBe(2);
    expect(doc.toString()).toBe('; top\n[S]\n# hash\ngarbage line\n');
  });

  it('handles missing final newline, BOM, mixed EOLs and global keys', () => {
    const src = '﻿g=1\r\n[A]\nx=1';
    const doc = IniDocument.parse(src);
    expect(doc.bom).toBe(true);
    expect(doc.toString()).toBe(src);
    expect(doc.get('', 'g')).toBe('1');
    doc.set('A', 'y', '2');
    expect(doc.toString()).toBe('﻿g=1\r\n[A]\nx=1\r\ny=2\r\n');
  });

  it('deleteSection removes header and body', () => {
    const doc = parseIni('[A]\r\nx=1\r\n[B]\r\ny=2\r\n[A]\r\nz=3\r\n');
    expect(doc.sections()).toEqual(['A', 'B']);
    expect(doc.entries('A')).toEqual([
      ['x', '1'],
      ['z', '3'],
    ]);
    expect(doc.deleteSection('a')).toBe(true);
    expect(doc.toString()).toBe('[B]\r\ny=2\r\n');
    expect(doc.hasSection('A')).toBe(false);
  });

  itFx('parses project.ini (Libmaker)', () => {
    // the Libmaker project.ini left in an older IDE data folder of the fixture (found, not named here)
    const old = readdirSync(join(FIXTURES, 'Lab3')).find((n) => /_data$/i.test(n) && n !== 'Lab3_Data' && statSync(join(FIXTURES, 'Lab3', n, 'Standard', 'ObjectCode', 'project.ini'), { throwIfNoEntry: false }))!;
    const doc = parseIni(readFixture('Lab3', old, 'Standard', 'ObjectCode', 'project.ini').toString('latin1'));
    expect(doc.get('Libmaker', 'EditorType')).toBe('4');
    expect(doc.get('Libmaker', 'CurrentCommandLine')).toContain('= ME305LibV4.0.lib');
  });
});
