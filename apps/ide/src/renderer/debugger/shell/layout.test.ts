import { describe, expect, it } from 'vitest';
import { parseHwl, writeHwl } from '@s12/formats';
// hiwave-format layout of our own (the 7-window assembly layout)
import { ASM_LAYOUT_HWL as asmLayoutText } from '../../common/monaco/testing/hiwave-texts';
import { colorrefToCss, cssToColorref, EMPTY_MDI, findWindow, hwlToMdi, iconSlots, mdiReducer, mdiToHwl, parseOpenArgs, tile, cascade, windowsForCommand, type MdiState } from './layout';
import type { HwlLayoutInfo } from '../../../shared/api';

const asmLayout = (): HwlLayoutInfo => {
  const l = parseHwl(asmLayoutText);
  return { ...l, otherRaw: l.other.map((c) => c.raw) };
};

const geo = (s: MdiState, title: string) => {
  const w = s.windows.find((x) => x.title === title)!;
  return [w.rect.x, w.rect.y, w.rect.w, w.rect.h];
};

describe('hwlToMdi (7-window assembly layout)', () => {
  const s = hwlToMdi(asmLayout());

  it('places every window at its percent rectangle', () => {
    expect(s.windows.map((w) => w.title)).toEqual(['Source', 'Register', 'Assembly', 'Memory', 'Procedure', 'Data', 'Command']);
    expect(geo(s, 'Source')).toEqual([0, 0, 58, 46]);
    expect(geo(s, 'Register')).toEqual([58, 0, 42, 28]);
    expect(geo(s, 'Assembly')).toEqual([58, 28, 42, 32]);
    expect(geo(s, 'Memory')).toEqual([58, 60, 42, 22]);
    expect(geo(s, 'Procedure')).toEqual([58, 82, 42, 18]);
    expect(geo(s, 'Data')).toEqual([0, 46, 58, 24]);
    expect(geo(s, 'Command')).toEqual([0, 70, 58, 30]);
    expect(s.unknown).toEqual([]);
  });

  it('stacks windows in ACTIVATE order; the last one is active', () => {
    const z = [...s.windows].sort((a, b) => a.z - b.z).map((w) => w.title);
    expect(z).toEqual(['Procedure', 'Memory', 'Assembly', 'Register', 'Command', 'Source', 'Data']);
    expect(s.windows.find((w) => w.id === s.active)?.title).toBe('Data');
  });

  it('keeps attributes and layout settings', () => {
    expect(s.windows.find((w) => w.title === 'Assembly')?.attributes).toContainEqual({ name: 'TOPPC', value: '0xC000' });
    expect(s.font).toEqual({ face: 'Consolas', size: 10, color: 'BLACK' });
    expect(s.bckcolor).toBe(49348607);
    expect(colorrefToCss(s.bckcolor!)).toBe('#fffff0');
    expect(s.autosize).toBe(true);
  });

  it('writes the same layout back (Save Configuration round trip)', () => {
    const back = mdiToHwl(s);
    const text = writeHwl({ ...back, other: [] }, '\r\n');
    // the ACTIVATE line is rewritten in z-order (which replays to the same stacking); everything else is identical
    const strip = (t: string) => t.replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('ACTIVATE')).join('\n');
    expect(strip(text)).toBe(strip(asmLayoutText));
    const again = hwlToMdi({ ...back, warnings: [] });
    expect(again.windows.map((w) => [w.title, w.z])).toEqual(s.windows.map((w) => [w.title, w.z]));
    expect(again.active && again.windows.find((w) => w.id === again.active)?.title).toBe('Data');
  });
});

describe('mdiReducer', () => {
  const base = () => hwlToMdi(asmLayout());

  it('opens a second Memory as Memory:1/Memory:2 and a single-instance component only once', () => {
    let s = mdiReducer(base(), { type: 'open', component: 'Memory' });
    expect(s.windows.filter((w) => w.component === 'Memory').map((w) => w.title)).toEqual(['Memory:1', 'Memory:2']);
    expect(s.windows.find((w) => w.id === s.active)?.title).toBe('Memory:2');
    const n = s.windows.length;
    s = mdiReducer(s, { type: 'open', component: 'Source' });
    expect(s.windows.length).toBe(n);
    expect(s.windows.find((w) => w.id === s.active)?.title).toBe('Source');
    // closing one renumbers the other back to "Memory"
    s = mdiReducer(s, { type: 'close', id: s.windows.find((w) => w.title === 'Memory:2')!.id });
    expect(s.windows.filter((w) => w.component === 'Memory').map((w) => w.title)).toEqual(['Memory']);
  });

  it('parses OPEN arguments with ;I / ;MAX flags', () => {
    expect(parseOpenArgs('memory 5 5 30 30;I')).toEqual({ name: 'memory', rect: { x: 5, y: 5, w: 30, h: 30 }, minimized: true, maximized: false });
    expect(parseOpenArgs('source 0 0 60 42 ;MAX')).toEqual({ name: 'source', rect: { x: 0, y: 0, w: 60, h: 42 }, minimized: false, maximized: true });
    expect(parseOpenArgs('register')).toEqual({ name: 'register', rect: undefined, minimized: false, maximized: false });
    expect(parseOpenArgs('  ')).toBeNull();
    let s = mdiReducer(EMPTY_MDI, { type: 'open', component: 'Memory', rect: { x: 5, y: 5, w: 30, h: 30 }, minimized: true });
    expect(s.windows[0]).toMatchObject({ minimized: true, rect: { x: 5, y: 5, w: 30, h: 30 } });
    s = mdiReducer(s, { type: 'open', component: 'Source', maximized: true });
    expect(s.windows.find((w) => w.component === 'Source')).toMatchObject({ maximized: true });
  });

  it('activates, minimizes, maximizes and restores', () => {
    let s = base();
    const src = findWindow(s, 'source')!;
    s = mdiReducer(s, { type: 'minimize', id: src.id });
    expect(s.windows.find((w) => w.id === src.id)?.minimized).toBe(true);
    expect(iconSlots(s.windows).get(src.id)).toBe(0);
    s = mdiReducer(s, { type: 'activate', id: src.id });
    expect(s.windows.find((w) => w.id === src.id)?.minimized).toBe(false);
    expect(s.active).toBe(src.id);
    s = mdiReducer(s, { type: 'maximize', id: src.id });
    expect(s.windows.find((w) => w.id === src.id)?.maximized).toBe(true);
    s = mdiReducer(s, { type: 'restore', id: src.id });
    expect(s.windows.find((w) => w.id === src.id)).toMatchObject({ maximized: false, rect: { x: 0, y: 0, w: 58, h: 46 } });
  });

  it('tiles into a grid that covers the area and cascades with offsets', () => {
    const t = tile(base().windows);
    const area = t.reduce((a, w) => a + w.rect.w * w.rect.h, 0);
    expect(Math.round(area)).toBe(10000);
    const c = cascade(base().windows);
    const sorted = [...c].sort((a, b) => a.z - b.z);
    expect(sorted[1].rect.x).toBeGreaterThan(sorted[0].rect.x);
    expect(sorted.every((w) => w.rect.w === 60 && w.rect.h === 60)).toBe(true);
  });

  it('routes UI commands by title, then by kind', () => {
    let s = mdiReducer(base(), { type: 'open', component: 'Memory' });
    expect(windowsForCommand(s, 'Memory:2').map((w) => w.title)).toEqual(['Memory:2']);
    expect(windowsForCommand(s, 'memory').map((w) => w.title)).toEqual(['Memory:1', 'Memory:2']);
    expect(windowsForCommand(s, 'Assembly').map((w) => w.title)).toEqual(['Assembly']);
    s = { ...EMPTY_MDI };
    expect(windowsForCommand(s, 'Assembly')).toEqual([]);
  });

  it('reports unknown components and places windows without geometry', () => {
    const s = hwlToMdi({ windows: [{ component: 'coverage', title: 'Coverage', x: 0, y: 0, w: 50, h: 50, attributes: [] }, { component: 'source', title: 'Source', x: 0, y: 0, w: 0, h: 0, hasGeometry: false, attributes: [] }], activate: [], otherRaw: [], warnings: [], eol: '\r\n' });
    expect(s.unknown).toEqual(['coverage']);
    expect(s.windows[0].rect.w).toBeGreaterThan(10);
  });

  it('converts colours both ways', () => {
    expect(cssToColorref('#ffffff')).toBe(50331647);
    expect(colorrefToCss(cssToColorref('#12abef'))).toBe('#12abef');
  });
});
