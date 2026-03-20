#!/usr/bin/env node
/**
 * 生成简单的 PNG 占位图标
 * 使用原生 Node.js zlib，无需额外依赖
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length, 0);
  const td  = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function makePNG(size, r, g, b) {
  const sig  = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8,8); ihdr.writeUInt8(2,9);          // 8-bit RGB
  ihdr.writeUInt8(0,10); ihdr.writeUInt8(0,11); ihdr.writeUInt8(0,12);

  // Raw scanlines: filter_byte(0) + RGB * width  per row
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter = None
    for (let x = 0; x < size; x++) {
      const px = row + 1 + x * 3;
      // 圆角效果：边角透明（但 RGB 颜色类型不支持透明度，直接画方块）
      raw[px] = r; raw[px+1] = g; raw[px+2] = b;
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR',ihdr), chunk('IDAT',idat), chunk('IEND',Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '../extension/icons');
fs.mkdirSync(outDir, { recursive: true });

// Coinank 品牌蓝色 #388bfd
const [R, G, B] = [0x38, 0x8b, 0xfd];

for (const size of [16, 48, 128]) {
  const png  = makePNG(size, R, G, B);
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`✓ ${file}`);
}
console.log('图标生成完成');
