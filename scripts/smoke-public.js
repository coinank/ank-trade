#!/usr/bin/env node
// 仅验证公开接口；不读取凭据、不调用账户接口、不提交订单。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { webcrypto } = require('crypto');

const dist = path.resolve(__dirname, '../extension/dist');
let listener;
const context = vm.createContext({
  console, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, Uint16Array,
  Uint32Array, Int32Array, ArrayBuffer, DataView, atob, btoa, fetch, AbortController,
  DOMException, crypto: webcrypto, setTimeout, clearTimeout,
  chrome: {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { getURL: name => `chrome-extension://public-smoke/${name}`, onMessage: { addListener(cb) { listener = cb; } } },
    storage: { local: { async get() { return {}; }, async set() {} } },
  },
}, { codeGeneration: { strings: false, wasm: false } });
context.self = context;
context.importScripts = name => {
  assert.equal(name, 'ccxt.browser.min.js');
  vm.runInContext(fs.readFileSync(path.join(dist, name), 'utf8'), context);
};
vm.runInContext('this.WorkerGlobalScope=class {}; Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);', context);
vm.runInContext(fs.readFileSync(path.join(dist, 'background.js'), 'utf8'), context);

function request(action, exchange, params) {
  assert.ok(['getMarkets', 'getTicker', 'getMarketTickers'].includes(action));
  return new Promise((resolve, reject) => listener({ action, exchange, params },
    { url: 'chrome-extension://public-smoke/sidepanel.html' }, response => {
      if (!response?.ok) return reject(new Error(response?.error || 'No response'));
      resolve(response.data);
    }));
}

async function main() {
  console.log(`Browser CCXT: ${context.ccxt.version}`);
  const exchanges = ['binance', 'okx', 'bybit', 'bitget', 'hyperliquid'];
  const results = await Promise.allSettled(exchanges.flatMap(exchange =>
    (exchange === 'hyperliquid' ? ['perp'] : ['spot', 'perp']).map(async marketType => {
      const markets = await request('getMarkets', exchange, { marketType });
      assert.ok(markets.length > 0);
      const symbol = marketType === 'spot' ? 'BTC/USDT' : (exchange === 'hyperliquid' ? 'BTC/USDC:USDC' : 'BTC/USDT:USDT');
      assert.ok(markets.includes(symbol));
      const ticker = await request('getTicker', exchange, { marketType, symbol });
      assert.ok(Number.isFinite(ticker.last) && ticker.last > 0);
      if (exchange === 'bybit' && marketType === 'spot') {
        const tickers = await request('getMarketTickers', exchange, { marketType });
        assert.ok(tickers[symbol]?.price > 0);
      }
      console.log(JSON.stringify({ exchange, marketType, markets: markets.length, symbol, last: ticker.last }));
    })));
  const failures = results.filter(result => result.status === 'rejected');
  for (const failure of failures) console.error(failure.reason.message);
  if (failures.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
