/**
 * Generates resources/icons/app.png — a circular red badge with a white
 * recording dot, matching the in-app REC indicator style.
 *
 * Uses only Node.js built-ins (zlib for PNG compression, fs for output).
 * Run once: node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dir, '..', 'resources', 'icons');
if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });

// ─── CRC32 (required by PNG chunk format) ────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── PNG writer ───────────────────────────────────────────────────────
function chunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makePng(size, pixel) {
  // IHDR: width, height, 8-bit RGBA
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // compression/filter/interlace all 0

  // Raw scanlines: 1 filter byte + width*4 bytes per row
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const i = y * (stride + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── icon design ─────────────────────────────────────────────────────
// Red circle (#ef4444) with a white filled dot in the centre.
function iconPixel(x, y, size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const outerR = size / 2;

  // Outside the outer circle → transparent
  if (dist >= outerR) return [0, 0, 0, 0];

  // Anti-alias the outer edge
  const alpha = dist > outerR - 1 ? Math.round((outerR - dist) * 255) : 255;

  // White dot radius ≈ 22 % of icon size
  const dotR = outerR * 0.22;
  if (dist <= dotR) return [255, 255, 255, alpha];

  // Red fill: #ef4444
  return [0xef, 0x44, 0x44, alpha];
}

// ─── output sizes ────────────────────────────────────────────────────
const sizes = [16, 32, 48, 64, 128, 256];
for (const sz of sizes) {
  const file = join(iconsDir, `app-${sz}.png`);
  writeFileSync(file, makePng(sz, iconPixel));
  console.log(`[make-icon] ${file}`);
}
// Canonical reference used by the app
const main = join(iconsDir, 'app.png');
writeFileSync(main, makePng(256, iconPixel));
console.log(`[make-icon] ${main} (256 px, canonical)`);
