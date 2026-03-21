#!/usr/bin/env node
/**
 * 生成插件图标（从 Coinank 官网 logo 裁剪缩放）
 * 依赖 macOS sips 命令；若 sips 不可用则回退为品牌色占位图
 */
const { execSync } = require('child_process');
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '../extension/icons');
fs.mkdirSync(outDir, { recursive: true });

const src = path.join(__dirname, 'coinank_icon.png');

if (fs.existsSync(src)) {
  // sips: resize source icon to each target size
  for (const size of [16, 48, 128]) {
    const dest = path.join(outDir, `icon${size}.png`);
    execSync(`sips -s format png -z ${size} ${size} "${src}" --out "${dest}" 2>/dev/null`);
    console.log(`✓ ${dest}`);
  }
} else {
  // Fallback: solid Coinank brand-blue squares
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
    ihdr.writeUInt8(8,8); ihdr.writeUInt8(2,9);
    ihdr.writeUInt8(0,10); ihdr.writeUInt8(0,11); ihdr.writeUInt8(0,12);
    const raw = Buffer.alloc(size * (1 + size * 3));
    for (let y = 0; y < size; y++) {
      const row = y * (1 + size * 3);
      raw[row] = 0;
      for (let x = 0; x < size; x++) {
        const px = row + 1 + x * 3;
        raw[px] = r; raw[px+1] = g; raw[px+2] = b;
      }
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([sig, chunk('IHDR',ihdr), chunk('IDAT',idat), chunk('IEND',Buffer.alloc(0))]);
  }
  const [R, G, B] = [0x38, 0x8b, 0xfd];
  for (const size of [16, 48, 128]) {
    const file = path.join(outDir, `icon${size}.png`);
    fs.writeFileSync(file, makePNG(size, R, G, B));
    console.log(`✓ ${file}`);
  }
}
console.log('图标生成完成');
