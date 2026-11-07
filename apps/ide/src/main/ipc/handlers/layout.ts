import { readFile, writeFile } from 'node:fs/promises';
import { parseHiwaveScript, parseHwl, writeHwl, type HwlLayout } from '@s12/formats';
import { minimalLayoutHwl } from '@s12/project';
import { ApiError } from '../../../shared/api/common';
import type { HwlLayoutInfo } from '../../../shared/api/layout';
import type { SessionInfo } from '../../../shared/api/debug';
import type { DomainHandlers } from '../router';
import { v } from '../validate';
import type { MainServices } from '../../services';

export function layoutToInfo(l: HwlLayout): HwlLayoutInfo {
  return {
    windows: l.windows.map((w) => ({ ...w, attributes: w.attributes.map((a) => ({ ...a })) })),
    bckcolor: l.bckcolor,
    font: l.font ? { ...l.font } : undefined,
    autosize: l.autosize,
    activate: [...l.activate],
    otherRaw: l.other.map((c) => c.raw),
    warnings: [...l.warnings],
    eol: l.eol,
  };
}

export function infoToHwlText(info: HwlLayoutInfo): string {
  const other = info.otherRaw.length ? parseHiwaveScript(info.otherRaw.join('\n')).commands : [];
  return writeHwl({ windows: info.windows, bckcolor: info.bckcolor, font: info.font, autosize: info.autosize, activate: info.activate, eol: info.eol, other }, info.eol);
}

const attr = v.object({ name: v.string({ max: 256 }), value: v.string({ max: 4096 }) });
const win = v.object({
  component: v.string({ min: 1, max: 64 }),
  title: v.string({ min: 1, max: 64 }),
  x: v.number(),
  y: v.number(),
  w: v.number(),
  h: v.number(),
  hasGeometry: v.optional(v.boolean()),
  openFlags: v.optional(v.string({ max: 256 })),
  attributes: v.array(attr, 256),
});
const layoutV = v.object({
  windows: v.array(win, 256),
  bckcolor: v.optional(v.int(0, 0xffffffff)),
  font: v.optional(v.object({ face: v.string({ max: 128 }), size: v.number(), color: v.string({ max: 64 }) })),
  autosize: v.optional(v.boolean()),
  activate: v.array(v.string({ max: 64 }), 256),
  otherRaw: v.array(v.string({ max: 4096 }), 4096),
  warnings: v.array(v.string({ max: 4096 }), 4096),
  eol: v.literal('\r\n', '\n'),
});

export function layoutHandlers(s: MainServices): DomainHandlers<'layout'> {
  return {
    read: {
      args: [v.path()],
      run: async (_ctx, path) => {
        const text = await readFile(path, 'latin1').catch((e: Error) => {
          throw new ApiError('not-found', `${path}: ${e.message}`);
        });
        return layoutToInfo(parseHwl(text));
      },
    },
    write: {
      args: [v.path(), layoutV],
      run: async (_ctx, path, layout) => {
        // Save Configuration / Window > Layout > Store write hiwave layouts only: a renderer cannot use this to
        // overwrite arbitrary files (sources, .mcp, .ini) with layout text.
        if (!/\.hwl$/i.test(path)) throw new ApiError('invalid-argument', `not a layout file (*.hwl): ${path}`);
        await writeFile(path, infoToHwlText(layout as HwlLayoutInfo), 'latin1');
      },
    },
    sessionLayoutPath: {
      args: [],
      run: async () => {
        if (!s.debug.running) return null;
        const info = (await s.debug.call('debug.session')) as SessionInfo | null;
        return info?.layoutPath ?? null;
      },
    },
    defaultLayout: { args: [], run: () => layoutToInfo(parseHwl(minimalLayoutHwl())) },
  };
}
