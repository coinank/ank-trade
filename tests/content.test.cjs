const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { root } = require('./helpers.cjs');

for (const [pathname, search, title, dom, expected] of [
  ['/chart/1000pepeusdt', '', '', '', '1000PEPE/USDT'],
  ['/chart', '?symbol=1INCHUSDT', '', '', '1INCH/USDT'],
  ['/', '', '1INCH/USDT | Coinank', '', '1INCH/USDT'],
  ['/', '', 'BTCUSDT price', '', 'BTC/USDT'],
  ['/', '', '', 'BTCUSDT', 'BTC/USDT'],
  ['/', '', '', 'ETH/USDC', 'ETH/USDC'],
]) {
  test(`page linkage parses ${pathname + search || title || dom} as ${expected}`, () => {
    const sent = [];
    const ctx = vm.createContext({
      location: { pathname, search, href: 'https://coinank.com' + pathname + search },
      document: { title, documentElement: {}, querySelector: selector => selector === 'title' ? null : (dom ? { textContent: dom, getAttribute: () => null } : null) },
      MutationObserver: class { observe() {} }, setTimeout() {},
      chrome: { runtime: { sendMessage: message => { sent.push(message); return Promise.resolve(); } } },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'src/content.js'), 'utf8'), ctx);
    assert.equal(sent[0]?.symbol, expected);
  });
}
