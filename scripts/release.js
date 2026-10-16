#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
if (pkg.version !== manifest.version) throw new Error('package.json 与 manifest.json 版本不一致');

for (const script of ['scripts/generate-icons.js', 'scripts/build.js']) {
  execFileSync(process.execPath, [script], { cwd: root, stdio: 'inherit' });
}
const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.cjs'));
execFileSync(process.execPath, ['--test', ...tests.map(name => `tests/${name}`)], { cwd: root, stdio: 'inherit' });

const files = [
  'manifest.json', 'sidepanel.html', 'popup.html', 'options.html',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png',
  'dist/background.js', 'dist/ccxt.browser.min.js', 'dist/content.js',
  'dist/popup.js', 'dist/popup.css', 'dist/sidepanel.css', 'dist/options.js', 'dist/options.css',
];
for (const file of files) {
  if (!fs.statSync(path.join(extension, file)).size) throw new Error(`发布文件为空：${file}`);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ank-trade-release-'));
try {
  const zip = path.join(temporary, 'extension.zip');
  execFileSync('zip', ['-q', '-X', zip, ...files], { cwd: extension, stdio: 'inherit' });
  const release = path.join(root, 'release', `coinank-trader-v${pkg.version}.zip`);
  fs.mkdirSync(path.dirname(release), { recursive: true });
  fs.copyFileSync(zip, release);
  console.log(`Release: ${release}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
