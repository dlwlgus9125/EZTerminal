// Generates the real app icon assets from appicon.png (source artwork), replacing
// the placeholder from generate-placeholder-icon.mjs (B-M1, kept for reference).
// Rerunnable: `node scripts/generate-app-icon.mjs`.
//
// - assets/icon.ico: multi-size Windows icon via png2icons (zero deps, pure JS —
//   resizes + packs in one step). `forWinExe: true` produces the BMP-for-small /
//   PNG-for-large mix png2icons recommends for icons embedded in an executable
//   (electron-packager embeds this via rcedit at package time), at sizes
//   16/24/32/48/64/72/96/128/256.
// - mobile/assets/icon-only.png, icon-foreground.png: copies of appicon.png for
//   @capacitor/assets' Custom Mode (legacy launcher icon + adaptive-icon
//   foreground layer).
// - mobile/assets/icon-background.png: solid navy fill matching appicon.png's
//   card background, for the adaptive-icon background layer.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import png2icons from 'png2icons';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'appicon.png');
const input = readFileSync(SRC);

// ── desktop .ico ─────────────────────────────────────────────────────────────
const ico = png2icons.createICO(input, png2icons.BICUBIC2, 0, false, true);
if (!ico) throw new Error('png2icons failed to generate icon.ico');
const icoOut = path.join(ROOT, 'assets', 'icon.ico');
mkdirSync(path.dirname(icoOut), { recursive: true });
writeFileSync(icoOut, ico);
console.log(`[icon] wrote ${icoOut} (${ico.length} bytes)`);

// ── android (Capacitor Custom Mode source files) ────────────────────────────
const mobileAssets = path.join(ROOT, 'mobile', 'assets');
mkdirSync(mobileAssets, { recursive: true });
copyFileSync(SRC, path.join(mobileAssets, 'icon-only.png'));
copyFileSync(SRC, path.join(mobileAssets, 'icon-foreground.png'));

// Flat-color PNG encoder (no image-processing dependency needed for a solid fill).
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodeSolidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB (opaque background layer — no alpha needed)
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = rowStart + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const NAVY = [0x0d, 0x14, 0x20]; // matches appicon.png's card background
const bg = encodeSolidPng(1024, NAVY);
const bgOut = path.join(mobileAssets, 'icon-background.png');
writeFileSync(bgOut, bg);
console.log(`[icon] wrote ${bgOut} (1024x1024 solid #0d1420)`);
console.log(`[icon] wrote ${path.join(mobileAssets, 'icon-only.png')} + icon-foreground.png (copies of appicon.png)`);
