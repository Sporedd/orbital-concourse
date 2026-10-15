/**
 * Generates the PWA icons (public/icons/*.png) from the pit crest of the arena banners
 * (src/world/banners.ts: a bone ring with three stacked chevrons) on the oxblood banner cloth
 * with the Scrap League accent band. No external assets, no dependencies: a tiny supersampled
 * rasteriser and a PNG encoder on node:zlib.
 *
 *   npx tsx scripts/pwa-icons.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

type RGB = [number, number, number];
const hex = (n: number): RGB => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const BG = hex(0x0c0d0e);
const CLOTH = hex(0x43100c);
const BONE = hex(0xeceae4);
const ACCENT = hex(0xff5f1f);

// ---- PNG ---------------------------------------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * size * 3, size * 3).copy(raw, y * (size * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---- crest -------------------------------------------------------------------------------------
function inPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Colour at a unit-square point (0..1). `pad` shrinks the crest (maskable safe zone). */
function shade(u: number, v: number, pad: number): RGB {
  const s = 1 - 2 * pad;
  const x = (u - pad) / s;
  const y = (v - pad) / s;
  // cloth square with the accent band, on the dark page
  if (x < 0 || x > 1 || y < 0 || y > 1) return BG;
  if (y > 0.07 && y < 0.12 && x > 0.08 && x < 0.92) return ACCENT;
  const cx = 0.5, cy = 0.56, R = 0.33, w = 0.05;
  const d = Math.hypot(x - cx, y - cy);
  if (Math.abs(d - R) < w / 2) return BONE;
  for (let k = 0; k < 3; k++) {
    const yy = cy - R * 0.45 + k * R * 0.38;
    const chev: [number, number][] = [
      [cx - R * 0.55, yy], [cx, yy + R * 0.3], [cx + R * 0.55, yy],
      [cx + R * 0.55, yy + R * 0.14], [cx, yy + R * 0.44], [cx - R * 0.55, yy + R * 0.14],
    ];
    if (inPoly(x, y, chev)) return BONE;
  }
  return CLOTH;
}

function render(size: number, pad: number): Uint8Array {
  const out = new Uint8Array(size * size * 3);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, pad);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (py * size + px) * 3;
      out[i] = Math.round(r / (SS * SS));
      out[i + 1] = Math.round(g / (SS * SS));
      out[i + 2] = Math.round(b / (SS * SS));
    }
  }
  return out;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'public', 'icons');
mkdirSync(dir, { recursive: true });
const icons: [string, number, number][] = [
  ['icon-192.png', 192, 0.04],
  ['icon-512.png', 512, 0.04],
  ['icon-maskable-512.png', 512, 0.14], // crest inside the 80 % safe zone
  ['apple-touch-icon.png', 180, 0.04],
];
for (const [name, size, pad] of icons) {
  writeFileSync(join(dir, name), png(size, render(size, pad)));
  console.log(`wrote public/icons/${name}`);
}
