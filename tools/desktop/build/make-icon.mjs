// make-icon.mjs — generate build/icon.png (1024×1024) with no image deps, just zlib.
//
// electron-builder reads build/icon.png and derives the per-OS icons (.icns/.ico)
// from it. The motif is a small knowledge graph (nodes + edges) on a sky→indigo
// gradient — on-brand for a pointer/graph viewer. Re-run with `node build/make-icon.mjs`
// after editing; the PNG is committed so CI needs no image tooling.
import zlib from "node:zlib";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const S = 1024;
const buf = new Float64Array(S * S * 4); // straight RGBA, 0..1

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

// Alpha-composite color (0..1 rgb, a) over the pixel at (x,y).
function over(x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const da = buf[i + 3];
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  buf[i] = (r * a + buf[i] * da * (1 - a)) / oa;
  buf[i + 1] = (g * a + buf[i + 1] * da * (1 - a)) / oa;
  buf[i + 2] = (b * a + buf[i + 2] * da * (1 - a)) / oa;
  buf[i + 3] = oa;
}

// Signed distance to a rounded rect centered at (cx,cy) with half-extents (hw,hh).
function sdRoundRect(px, py, cx, cy, hw, hh, cr) {
  const qx = Math.abs(px - cx) - (hw - cr);
  const qy = Math.abs(py - cy) - (hh - cr);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - cr;
}

// Distance from point to segment.
function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const NODES = [
  [330, 360],
  [710, 300],
  [540, 560],
  [380, 745],
  [735, 690],
];
const EDGES = [
  [0, 2],
  [1, 2],
  [2, 3],
  [2, 4],
  [0, 3],
];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // Background rounded square with a vertical sky→indigo gradient.
    const d = sdRoundRect(x + 0.5, y + 0.5, S / 2, S / 2, S / 2 - 8, S / 2 - 8, 200);
    const cov = clamp(0.5 - d, 0, 1);
    if (cov > 0) {
      const t = y / S;
      over(x, y, lerp(0.05, 0.16, t), lerp(0.55, 0.22, t), lerp(0.86, 0.69, t), cov);
    }
  }
}

// Edges (semi-transparent white), then nodes (solid white with a faint sky core).
for (const [a, b] of EDGES) {
  const [ax, ay] = NODES[a];
  const [bx, by] = NODES[b];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dist = sdSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
      const cov = clamp(13 - dist, 0, 1) * 0.85;
      if (cov > 0) over(x, y, 0.92, 0.97, 1.0, cov);
    }
  }
}
for (const [cx, cy] of NODES) {
  for (let y = cy - 90; y < cy + 90; y++) {
    for (let x = cx - 90; x < cx + 90; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - 62;
      const cov = clamp(0.5 - dist, 0, 1);
      if (cov > 0) over(x, y, 1.0, 1.0, 1.0, cov);
    }
  }
}

// Encode RGBA → PNG (8-bit, filter 0 per row), with CRC32 + zlib deflate.
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc(S * (1 + S * 4));
for (let y = 0; y < S; y++) {
  raw[y * (1 + S * 4)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const o = y * (1 + S * 4) + 1 + x * 4;
    raw[o] = Math.round(clamp(buf[i], 0, 1) * 255);
    raw[o + 1] = Math.round(clamp(buf[i + 1], 0, 1) * 255);
    raw[o + 2] = Math.round(clamp(buf[i + 2], 0, 1) * 255);
    raw[o + 3] = Math.round(clamp(buf[i + 3], 0, 1) * 255);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "icon.png");
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
