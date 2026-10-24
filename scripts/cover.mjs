// Generates cover.png (800x534) for gladys-saunum: plain Node, no dependency.
// A sauna stove with its stones and heat waves, a thermometer, a bench and a
// wall control panel linked to the local network, on a warm wood gradient (no
// brand logo). Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [135 + 45 * t, 85 + 35 * t, 55 + 20 * t]);
  }
}
const white = [255, 255, 255];
const dark = [22, 40, 70];
const wood = [205, 150, 95];
const steel = [120, 130, 140];
const stone = [95, 95, 100];
const heat = [235, 85, 50];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// An arc of a ring, between two angles (radians, 0 = right, clockwise on screen).
const arc = (cx, cy, r, width, from, to, color) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      if (angle < from || angle > to) continue;
      const a = Math.max(
        0,
        Math.min(1, width / 2 - Math.abs(Math.hypot(x - cx, y - cy) - r) + 0.5),
      );
      if (a > 0) set(x, y, color, a);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

// Soft halo.
disc(400, 260, 250, white, 0.07);

// Wooden wall planks.
for (let i = 0; i < 9; i += 1) {
  box(0, 40 + i * 52, W, 43 + i * 52, 0, dark, 0.18);
}

// Bench on the right.
box(560, 330, 760, 352, 6, wood);
box(575, 352, 590, 440, 4, wood);
box(730, 352, 745, 440, 4, wood);

// The stove: a dark body, a grill, a basket of stones on top.
box(250, 250, 470, 450, 24, dark);
box(270, 270, 450, 300, 10, steel);
for (const x of [290, 330, 370, 410]) {
  box(x, 320, x + 22, 430, 8, steel, 0.55);
}
for (const [x, y, r] of [
  [285, 235, 26],
  [330, 225, 30],
  [380, 228, 28],
  [428, 238, 24],
  [305, 205, 22],
  [355, 198, 24],
  [405, 207, 22],
]) {
  disc(x, y, r, stone);
  disc(x - r / 3, y - r / 3, r / 3, white, 0.25);
}

// Heat waves above the stones.
for (const x of [300, 360, 420]) {
  for (let k = 0; k < 3; k += 1) {
    line(x + (k % 2 ? 10 : -10), 170 - k * 30, x + (k % 2 ? -10 : 10), 145 - k * 30, 7, heat);
  }
}

// Thermometer on the left.
box(120, 150, 150, 380, 15, white);
box(128, 230, 142, 372, 7, heat);
disc(135, 385, 26, white);
disc(135, 385, 17, heat);

// A wall control panel with a power symbol, linked to the local network.
box(590, 85, 730, 215, 18, white);
box(606, 101, 714, 199, 10, dark);
arc(660, 156, 22, 7, -Math.PI, -2.1, white);
arc(660, 156, 22, 7, -1.04, Math.PI, white);
line(660, 124, 660, 156, 7, white);
line(660, 215, 660, 255, 6, white);
line(600, 255, 720, 255, 6, white);
disc(600, 255, 12, white);
disc(660, 255, 12, white);
disc(720, 255, 12, white);
// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
