#!/usr/bin/env node
const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const dist = path.join(__dirname, '../extension/dist');
fs.mkdirSync(dist, { recursive: true });

const isWatch = process.argv.includes('--watch');

async function build() {
  console.log('🔨 构建 Coinank Trader 插件...\n');

  // 0. 复制 ccxt 浏览器包（由 importScripts 加载，不参与 esbuild 打包）
  const ccxtSrc  = path.join(__dirname, '../node_modules/ccxt/dist/ccxt.browser.min.js');
  const ccxtDest = path.join(dist, 'ccxt.browser.min.js');
  fs.copyFileSync(ccxtSrc, ccxtDest);
  console.log('✓ dist/ccxt.browser.min.js');

  // 1. Background service worker（IIFE 格式，配合 importScripts 加载 ccxt）
  await esbuild.build({
    entryPoints: ['src/background.js'],
    outfile:     'extension/dist/background.js',
    bundle:      false,   // background.js 不再 import 本地模块，无需打包
    platform:    'browser',
    format:      'iife',
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

  // 4. Content script（Coinank 页面交易对检测）
  await esbuild.build({
    entryPoints: ['src/content.js'],
    outfile:     'extension/dist/content.js',
    bundle:      false,
    platform:    'browser',
    format:      'iife',
    target:      'chrome114',
    minify:      !isWatch,
    sourcemap:   isWatch,
  });
  console.log('✓ dist/content.js');

  // 4. CSS 直接复制（无需打包）
  fs.copyFileSync('src/popup.css',    'extension/dist/popup.css');
  console.log('✓ dist/popup.css');
  fs.copyFileSync('src/options.css',  'extension/dist/options.css');
  console.log('✓ dist/options.css');
  fs.copyFileSync('src/sidepanel.css','extension/dist/sidepanel.css');
  console.log('✓ dist/sidepanel.css');

  console.log('\n✅ 构建完成！');
  console.log('   在 Chrome 中加载：chrome://extensions  →  开发者模式  →  加载已解压的扩展程序');
  console.log('   选择目录: extension/\n');
}

build().catch(err => { console.error('构建失败:', err); process.exit(1); });
