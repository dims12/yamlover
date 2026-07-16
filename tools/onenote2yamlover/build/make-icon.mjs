// make-icon.mjs — generate OneNote2Yamlover/icon.ico with no image deps, just zlib.
//
// Same knowledge-graph-on-gradient motif as tools/desktop/build/make-icon.mjs (the
// yamlover desktop icon), plus a OneNote-purple corner badge with a white "N" so the
// converter is distinguishable in the taskbar. Each size is rendered from the vector
// scene directly — no downscaling. Re-run with `node build/make-icon.mjs` after
// editing; the .ico is committed so the .NET build needs no image tooling.
import zlib from "node:zlib";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const M = 1024; // master coordinate space; every size S renders at scale S/M

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

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

// OneNote purple (#7719AA) badge, bottom-right, with a white "N".
const BADGE = { cx: 756, cy: 756, half: 212, r: 72 };
const PURPLE = [0x77 / 255, 0x19 / 255, 0xaa / 255];
const N_STROKES = [
  [688, 852, 688, 660],
  [688, 660, 824, 852],
  [824, 852, 824, 660],
];

// Render the scene at S×S; returns straight RGBA bytes, top-down.
function render(S) {
  const k = S / M;
  const buf = new Float64Array(S * S * 4); // straight RGBA, 0..1

  // Alpha-composite color (0..1 rgb, a) over the pixel at (x,y).
  const over = (x, y, r, g, b, a) => {
    if (a <= 0) return;
    const i = (y * S + x) * 4;
    const da = buf[i + 3];
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    buf[i] = (r * a + buf[i] * da * (1 - a)) / oa;
    buf[i + 1] = (g * a + buf[i + 1] * da * (1 - a)) / oa;
    buf[i + 2] = (b * a + buf[i + 2] * da * (1 - a)) / oa;
    buf[i + 3] = oa;
  };

  // Strokes must survive 16px, where a faithful scale would vanish.
  const edgeW = Math.max(13 * k, 0.7);
  const nodeR = Math.max(62 * k, 1.6);
  const nW = Math.max(27 * k, 0.9);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = (x + 0.5) / k;
      const py = (y + 0.5) / k;

      // Background rounded square with a vertical sky→indigo gradient.
      const d = sdRoundRect(px, py, M / 2, M / 2, M / 2 - 8, M / 2 - 8, 200) * k;
      const cov = clamp(0.5 - d, 0, 1);
      if (cov <= 0) continue;
      const t = py / M;
      over(x, y, lerp(0.05, 0.16, t), lerp(0.55, 0.22, t), lerp(0.86, 0.69, t), cov);

      // Edges (semi-transparent white), then nodes (solid white).
      for (const [a, b] of EDGES) {
        const dist = sdSegment(px, py, ...NODES[a], ...NODES[b]) * k;
        over(x, y, 0.92, 0.97, 1.0, clamp(edgeW - dist, 0, 1) * 0.85 * cov);
      }
      for (const [cx, cy] of NODES) {
        const dist = Math.hypot(px - cx, py - cy) * k - nodeR;
        over(x, y, 1.0, 1.0, 1.0, clamp(0.5 - dist, 0, 1) * cov);
      }

      // The badge covers whatever graph falls under it; the "N" goes on top.
      const bd = sdRoundRect(px, py, BADGE.cx, BADGE.cy, BADGE.half, BADGE.half, BADGE.r) * k;
      over(x, y, ...PURPLE, clamp(0.5 - bd, 0, 1) * cov);
      for (const [ax, ay, bx, by] of N_STROKES) {
        const dist = sdSegment(px, py, ax, ay, bx, by) * k;
        over(x, y, 1.0, 1.0, 1.0, clamp(nW - dist, 0, 1) * clamp(0.5 - bd, 0, 1) * cov);
      }
    }
  }

  const rgba = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S * 4; i++) rgba[i] = Math.round(clamp(buf[i], 0, 1) * 255);
  return rgba;
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
function png(S, rgba) {
  const raw = Buffer.alloc(S * (1 + S * 4));
  for (let y = 0; y < S; y++) {
    raw[y * (1 + S * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + S * 4) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Encode RGBA → ICO BMP entry: BITMAPINFOHEADER + bottom-up BGRA + all-zero AND mask
// (32-bit alpha makes the mask moot, but the header height must still count it).
function bmp(S, rgba) {
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(S, 4);
  hdr.writeInt32LE(S * 2, 8); // XOR + AND
  hdr.writeUInt16LE(1, 12); // planes
  hdr.writeUInt16LE(32, 14); // bpp
  hdr.writeUInt32LE(S * S * 4, 20);
  const xor = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = ((S - 1 - y) * S + x) * 4; // bottom-up
      const o = (y * S + x) * 4;
      xor[i] = rgba[o + 2];
      xor[i + 1] = rgba[o + 1];
      xor[i + 2] = rgba[o];
      xor[i + 3] = rgba[o + 3];
    }
  const and = Buffer.alloc(((S + 31) >> 5) * 4 * S);
  return Buffer.concat([hdr, xor, and]);
}

// Pack the ICO: BMP entries for the small sizes (maximum shell compatibility),
// PNG for the large ones (Vista+ convention, keeps the file small).
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = SIZES.map((S) => {
  const rgba = render(S);
  return { S, data: S >= 128 ? png(S, rgba) : bmp(S, rgba) };
});

const dir = Buffer.alloc(6 + entries.length * 16);
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(entries.length, 4);
let offset = dir.length;
entries.forEach(({ S, data }, i) => {
  const e = 6 + i * 16;
  dir[e] = S === 256 ? 0 : S;
  dir[e + 1] = S === 256 ? 0 : S;
  dir.writeUInt16LE(1, e + 4); // planes
  dir.writeUInt16LE(32, e + 6); // bpp
  dir.writeUInt32LE(data.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
const ico = Buffer.concat([dir, ...entries.map((e) => e.data)]);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "OneNote2Yamlover", "icon.ico");
fs.writeFileSync(out, ico);
// A human-viewable preview next to the script; the app consumes only the .ico.
fs.writeFileSync(join(here, "icon-preview.png"), png(256, render(256)));
console.log(`wrote ${out} (${ico.length} bytes)`);
