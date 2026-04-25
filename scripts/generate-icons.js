#!/usr/bin/env node
'use strict';
// Generates icon-192.png, icon-512.png, apple-touch-icon.png
// Black background with a green (#4ADE80) circle — matches app accent color.
// Run once: node scripts/generate-icons.js

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function crc32(buf) {
  const t = new Uint32Array(256).map((_, i) => {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    return c;
  });
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tb  = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}

function makePNG(size) {
  const cx = size / 2, cy = size / 2;
  const r  = size * 0.40; // circle radius (80% of half-width)
  const rr = r * r;
  // Inner ">" glyph — draw as two angled thick lines
  const rowLen = 1 + size * 3;
  const raw    = Buffer.alloc(rowLen * size); // all zeros = black

  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter byte = None
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist2 = dx * dx + dy * dy;
      const offset = y * rowLen + 1 + x * 3;

      if (dist2 <= rr) {
        // Green circle interior
        raw[offset]     = 0x4A; // R 74  → #4ADE80
        raw[offset + 1] = 0xDE; // G 222
        raw[offset + 2] = 0x80; // B 128

        // Draw ">" chevron in black inside the circle
        // Normalize coords to [-1, 1] relative to circle
        const nx = dx / r, ny = dy / r;
        const thick = 0.09; // line thickness
        // Upper arm: line from (-0.35, -0.55) to (0.35, 0)
        // Lower arm: line from (-0.35,  0.55) to (0.35, 0)
        const onUpperArm = distToSegment(nx, ny, -0.35, -0.55, 0.35, 0) < thick;
        const onLowerArm = distToSegment(nx, ny, -0.35,  0.55, 0.35, 0) < thick;

        if (onUpperArm || onLowerArm) {
          raw[offset]     = 0x00;
          raw[offset + 1] = 0x00;
          raw[offset + 2] = 0x00;
        }
      }
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'icon-192.png'),        makePNG(192));
fs.writeFileSync(path.join(root, 'icon-512.png'),        makePNG(512));
fs.writeFileSync(path.join(root, 'apple-touch-icon.png'), makePNG(192));
console.log('Icons generated: icon-192.png, icon-512.png, apple-touch-icon.png');
