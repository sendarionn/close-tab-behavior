const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function insideRoundedRect(x, y, size, radius) {
  const cx = Math.max(radius, Math.min(size - radius, x));
  const cy = Math.max(radius, Math.min(size - radius, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function arrowAt(x, y, size) {
  const p = (value) => value * size;
  const stroke = p(0.105);
  const parts = [
    [p(0.21), p(0.39), p(0.48), p(0.39)],
    [p(0.21), p(0.39), p(0.39), p(0.21)],
    [p(0.21), p(0.39), p(0.39), p(0.57)]
  ];
  if (parts.some(([ax, ay, bx, by]) => distanceToSegment(x, y, ax, ay, bx, by) <= stroke / 2)) {
    return true;
  }

  const cx = p(0.59);
  const cy = p(0.59);
  const radius = p(0.22);
  const distance = Math.hypot(x - cx, y - cy);
  const angle = Math.atan2(y - cy, x - cx);
  return angle > -Math.PI / 2 && angle < Math.PI * 0.82 &&
    Math.abs(distance - radius) <= stroke / 2;
}

function makePng(size) {
  const scale = 4;
  const width = size * scale;
  const rgba = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    rgba[row] = 0;
    for (let x = 0; x < size; x++) {
      let coral = 0;
      let white = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = x + (sx + 0.5) / scale;
          const py = y + (sy + 0.5) / scale;
          if (insideRoundedRect(px, py, size, size * 0.235)) coral++;
          if (arrowAt(px, py, size)) white++;
        }
      }
      const coverage = coral / (scale * scale);
      const arrow = white / (scale * scale);
      const offset = row + 1 + x * 4;
      rgba[offset] = Math.round(231 + (255 - 231) * arrow);
      rgba[offset + 1] = Math.round(86 + (253 - 86) * arrow);
      rgba[offset + 2] = Math.round(60 + (248 - 60) * arrow);
      rgba[offset + 3] = Math.round(255 * Math.max(coverage, arrow));
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rgba)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const outputDirectory = path.join(__dirname, "..", "icons");
fs.mkdirSync(outputDirectory, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outputDirectory, `icon${size}.png`), makePng(size));
}
