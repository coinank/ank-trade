const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const esbuild = require('esbuild');
const { root } = require('./helpers.cjs');

function bundledWorker() {
  let listener;
  const ctx = vm.createContext({
    console, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, Uint16Array,
    Uint32Array, Int32Array, ArrayBuffer, DataView, atob, btoa, AbortController,
    DOMException, crypto: webcrypto, setTimeout() {}, clearTimeout() {},
    fetch: async () => { throw new Error('Network forbidden'); },
    chrome: {
      alarms: { create() {}, onAlarm: { addListener() {} } },
      sidePanel: { setPanelBehavior: async () => {} },
      runtime: { getURL: name => 'chrome-extension://audit/' + name, onMessage: { addListener(cb) { listener = cb; } } },
      storage: { local: { async get() { return {}; }, async set() {} } },
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  ctx.self = ctx;
  ctx.importScripts = name => {
    assert.equal(name, 'ccxt.browser.min.js');
    vm.runInContext(fs.readFileSync(path.join(root, 'node_modules/ccxt/dist', name), 'utf8'), ctx);
  };
  vm.runInContext('this.WorkerGlobalScope=class {}; Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);', ctx);
  const bundle = esbuild.transformSync(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8'), {
    format: 'iife', minify: true, target: 'chrome120',
  }).code;
  vm.runInContext(bundle, ctx);
  return {
    run: code => vm.runInContext(code, ctx),
    send: (message, url = 'chrome-extension://audit/sidepanel.html') => new Promise(resolve => listener(message, { url }, resolve)),
  };
}

test('production-style worker boots with eval disabled and rejects untrusted trading messages', async () => {
  const worker = bundledWorker();
  const blocked = await worker.send({ action: 'placeOrder', exchange: 'binance' }, 'https://coinank.com/chart');
  assert.equal(blocked.ok, false);
  const missingKey = await worker.send({ action: 'placeOrder', exchange: 'binance', params: {} });
  assert.equal(missingKey.ok, false);
  assert.match(missingKey.error, /API Key/);
});

test('bundled Hyperliquid local signing works without eval or WebAssembly', () => {
  const worker = bundledWorker();
  const signature = worker.run(`
    new self.ccxt.hyperliquid({privateKey:'0x'+'1'.repeat(64),walletAddress:'0x'+'2'.repeat(40)})
      .signL1Action({type:'cancel',cancels:[]},1760000000000)
  `);
  assert.match(signature.r, /^0x[0-9a-f]{64}$/i);
  assert.match(signature.s, /^0x[0-9a-f]{64}$/i);
  assert.ok([27, 28].includes(signature.v));
});
