import { describe, expect, it } from 'vitest';
import { fitToWorkArea, mainFrameFromIni, parseMainFrame } from './window-placement';

/** A connection .ini's [HI-WAVE] section with the MainFrame= value hiwave writes (show flags, -1s, normal rect). */
const ini = (mainFrame: string): string => `[Environment Variables]\r\nOBJPATH={Project}bin\r\n\r\n[HI-WAVE]\r\nTarget=sim\r\nLayout=ASM_layout.hwl\r\nMainFrame=${mainFrame}\r\n`;

describe('hiwave MainFrame placement', () => {
  it('a maximized MainFrame (2,3,...) opens maximized with its normal rectangle', () => {
    const p = mainFrameFromIni(ini('2,3,-1,-1,-1,-1,242,242,1202,971'));
    expect(p).toEqual({ maximized: true, minimized: false, normal: { x: 242, y: 242, width: 960, height: 729 } });
  });

  it('a normal MainFrame (0,1,...) opens as a normal window', () => {
    const p = mainFrameFromIni(ini('0,1,-1,-1,-1,-1,192,151,1152,869'));
    expect(p?.maximized).toBe(false);
    expect(p?.normal).toEqual({ x: 192, y: 151, width: 960, height: 718 });
  });

  it('rejects malformed values', () => {
    expect(parseMainFrame(undefined)).toBeUndefined();
    expect(parseMainFrame('2,3,-1')).toBeUndefined();
    expect(parseMainFrame('2,3,-1,-1,-1,-1,10,10,5,5')).toBeUndefined();
    expect(parseMainFrame('a,3,-1,-1,-1,-1,1,1,5,5')).toBeUndefined();
    expect(mainFrameFromIni('[OTHER]\nMainFrame=2,3,-1,-1,-1,-1,1,1,500,500\n')).toBeUndefined();
  });

  it('fits a second-monitor rectangle into the visible work area', () => {
    const p = mainFrameFromIni(ini('2,3,-1,-1,-1,-1,1284,12,2520,1025'))!;
    const r = fitToWorkArea(p.normal, [{ x: 0, y: 0, width: 1920, height: 1040 }]);
    expect(r.x + r.width).toBeLessThanOrEqual(1920);
    expect(r.y + r.height).toBeLessThanOrEqual(1040);
    expect(r.width).toBe(1236);
    // a rectangle on the second display stays there
    const two = [{ x: 0, y: 0, width: 1280, height: 1000 }, { x: 1280, y: 0, width: 1920, height: 1040 }];
    expect(fitToWorkArea(p.normal, two)).toEqual({ x: 1284, y: 12, width: 1236, height: 1013 });
  });
});
