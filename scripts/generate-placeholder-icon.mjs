// Generates assets/icon.ico — a PLACEHOLDER app icon (dark rounded square with a
// terminal chevron ❯ and cursor block) until real icon art is provided (B-M1).
// Rerunnable: `node scripts/generate-placeholder-icon.mjs`. No dependencies —
// hand-rolled PNG (256px entry) + BMP DIB (16/32/48 entries; small BMP entries
// render more reliably than small PNG entries in older shell surfaces).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'icon.ico');

// ── art ──────────────────────────────────────────────────────────────────────
// Palette matches the app chrome (renderer/index.css): near-black console bg,
// terminal-green prompt glyph.
const BG = [13, 17, 23, 255]; // #0d1117
const EDGE = [48, 54, 61, 255]; // subtle border
const GLYPH = [22, 198, 12, 255]; // Windows-terminal green #16c60c

/** Signed distance from point to segment. */
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** RGBA pixel (u,v in [0,1]) with 2x2 supersampling done by the caller. */
function shade(u, v) {
  // Rounded-square silhouette.
  const r = 0.16;
  const cx = Math.max(r, Math.min(1 - r, u));
  const cy = Math.max(r, Math.min(1 - r, v));
  const dEdge = Math.hypot(u - cx, v - cy);
  if (dEdge > r) return [0, 0, 0, 0];

  // Chevron ❯ : two strokes, plus a cursor block lower-right.
  const w = 0.075; // stroke half-width
  const d1 = segDist(u, v, 0.28, 0.3, 0.52, 0.5);
  const d2 = segDist(u, v, 0.52, 0.5, 0.28, 0.7);
  const inChevron = Math.min(d1, d2) < w;
  const inCursor = u >= 0.58 && u <= 0.78 && v >= 0.62 && v <= 0.74;
  if (inChevron || inCursor) return GLYPH;

  // Thin border ring just inside the silhouette.
  if (dEdge > r - 0.02) return EDGE;
  return BG;
}

/** Render size×size RGBA buffer (2x2 supersampled). */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let as = 0;
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const [r, g, b, a] = shade((x + ox) / size, (y + oy) / size);
        rs += r;
        gs += g;
        bs += b;
        as += a;
      }
      const i = (y * size + x) * 4;
      px[i] = rs / 4;
      px[i + 1] = gs / 4;
      px[i + 2] = bs / 4;
      px[i + 3] = as / 4;
    }
  }
  return px;
}

// ── PNG encoder (for the 256px entry) ────────────────────────────────────────
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
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── BMP DIB encoder (16/32/48 entries) ───────────────────────────────────────
function encodeDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND heights
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  const xor = Buffer.alloc(size * size * 4); // BGRA, bottom-up
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  // 1bpp AND mask, rows padded to 32 bits — all zero (alpha governs on 32bpp).
  const andStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(andStride * size);
  return Buffer.concat([header, xor, and]);
}

// ── ICO container ────────────────────────────────────────────────────────────
const entries = [16, 32, 48].map((s) => ({ size: s, data: encodeDib(s, render(s)) }));
entries.push({ size: 256, data: encodePng(256, render(256)) });

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(entries.length, 4);

let offset = 6 + entries.length * 16;
const dirEntries = [];
for (const { size, data } of entries) {
  const e = Buffer.alloc(16);
  e[0] = size === 256 ? 0 : size;
  e[1] = size === 256 ? 0 : size;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  dirEntries.push(e);
  offset += data.length;
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.data)]));
console.log(`[icon] wrote ${OUT} (${entries.map((e) => e.size).join('/')} px)`);
