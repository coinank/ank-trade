#!/usr/bin/env node
const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const dist = path.join(__dirname, '../extension/dist');
fs.mkdirSync(dist, { recursive: true });

const isWatch = process.argv.includes('--watch');

async function build() {
  console.log('🔨 构建 Coinank Trader 插件...\n');

  // 1. Background service worker（ESM 格式，支持 import）
  await esbuild.build({
    entryPoints: ['src/background.js'],
    outfile:     'extension/dist/background.js',
    bundle:      true,
    platform:    'browser',
    format:      'esm',
    target:      'chrome114',
    minify:      !isWatch,
    sourcemap:   isWatch,
  });
  console.log('✓ dist/background.js');

  // 2. Popup 脚本（IIFE，直接被 popup.html 加载）
  await esbuild.build({
    entryPoints: ['src/popup.js'],
    outfile:     'extension/dist/popup.js',
    bundle:      true,
    platform:    'browser',
    format:      'iife',
    target:      'chrome114',
    minify:      !isWatch,
    sourcemap:   isWatch,
  });
  console.log('✓ dist/popup.js');

  // 3. Options 脚本
  await esbuild.build({
    entryPoints: ['src/options.js'],
    outfile:     'extension/dist/options.js',
    bundle:      true,
    platform:    'browser',
    format:      'iife',
    target:      'chrome114',
    minify:      !isWatch,
    sourcemap:   isWatch,
  });
  console.log('✓ dist/options.js');

  // 4. CSS 直接复制（无需打包）
  fs.copyFileSync('src/popup.css',   'extension/dist/popup.css');
  console.log('✓ dist/popup.css');
  fs.copyFileSync('src/options.css', 'extension/dist/options.css');
  console.log('✓ dist/options.css');

  console.log('\n✅ 构建完成！');
  console.log('   在 Chrome 中加载：chrome://extensions  →  开发者模式  →  加载已解压的扩展程序');
  console.log('   选择目录: extension/\n');
}

build().catch(err => { console.error('构建失败:', err); process.exit(1); });
