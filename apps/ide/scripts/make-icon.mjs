#!/usr/bin/env node
/**
 * node scripts/make-icon.mjs : render build/icon.svg to
 *   build/icon.png    1024x1024 (Linux, BrowserWindow icon, electron-builder source)
 *   build/icon.ico    Windows: 16/24/32/48/64/128/256 PNG entries (exe, installer, .mcp file association)
 *   build/icon.icns   macOS: 16..1024 PNG entries (app bundle, .mcp document icon)
 *
 * No image libraries: the script re-launches itself inside Electron (already a dev dependency) and rasterises the
 * SVG with Chromium (each size rendered from the vector, not downscaled). ICO and ICNS are plain containers of PNGs,
 * written here. Re-run after editing icon.svg and commit the outputs.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(here);
const out = (n) => join(appDir, 'build', n);

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** ICNS OSType -> pixel size (PNG payloads; ic11..ic14 are the @2x variants). */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

if (!process.versions.electron) {
  const { electronArgs, electronEnv, electronPath } = await import('./env.mjs');
  const r = spawnSync(electronPath(), [...electronArgs(), fileURLToPath(import.meta.url)], { stdio: 'inherit', env: electronEnv() });
  process.exit(r.status ?? 1);
} else {
  // no top-level await on app.whenReady(): Electron emits "ready" only after the ESM entry finished evaluating
  const { app } = await import('electron');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.whenReady().then(render, (e) => {
    console.error(e);
    app.exit(1);
  });
}

/** ICO with PNG-compressed entries (Windows Vista+). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); // 0 = 256
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2); // palette
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bpp
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

/** ICNS: 'icns' + total length (BE), then (OSType, 8 + length, PNG) entries. */
function icns(entries) {
  const parts = entries.map(({ type, data }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'latin1');
    h.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([h, data]);
  });
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'latin1');
  h.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([h, ...parts]);
}

async function render() {
  // The SVG is drawn onto canvases (a window is clamped to the screen size, a canvas is not) and read back as PNG.
  const { app, BrowserWindow } = await import('electron');
  const svg = readFileSync(out('icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 320, height: 240, show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>');
  const sizes = [...new Set([1024, ...ICO_SIZES, ...ICNS_TYPES.map(([, s]) => s)])];
  const urls = await win.webContents.executeJavaScript(`new Promise((ok, fail) => {
    const img = new Image(1024, 1024);
    img.onload = () => ok(${JSON.stringify(sizes)}.map((n) => {
      const c = document.createElement('canvas');
      c.width = c.height = n;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, n, n);
      return [n, c.toDataURL('image/png')];
    }));
    img.onerror = () => fail(new Error('svg failed to load'));
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
  })`);
  const png = new Map(urls.map(([n, u]) => [n, Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')]));
  writeFileSync(out('icon.png'), png.get(1024));
  writeFileSync(out('icon.ico'), ico(ICO_SIZES.map((size) => ({ size, data: png.get(size) }))));
  writeFileSync(out('icon.icns'), icns(ICNS_TYPES.map(([type, size]) => ({ type, data: png.get(size) }))));
  console.log(`build/icon.png (1024), build/icon.ico (${ICO_SIZES.join('/')}), build/icon.icns (${ICNS_TYPES.length} entries)`);
  app.exit(0);
}
